import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, downloadClients } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { getImportService } from '#lib/server/downloadClients/import/index.js';
import {
	getContentPath,
	buildTorrentRecoveryPath,
	isSafeRecoveryCandidate
} from '#lib/server/downloadClients/monitoring/index.js';
import type { DownloadInfo } from '#lib/server/downloadClients/core/interfaces.js';
import { createChildLogger } from '#lib/logging/index.js';
import { redactUrl } from '#lib/server/utils/urlSecurity.js';
import { matchesImportError } from '#lib/types/activity.js';
import { DebridHandler } from '#lib/server/downloads/handlers/DebridHandler.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'QueueRetryApi', logDomain: 'downloads' });

const MAX_IMPORT_ATTEMPTS = 10;
const AMBIGUOUS_SUBMISSION_MARKER = '[ambiguous_submission]';
const DEBRID_CONFIGURATION_ERROR =
	'Stored API token is unavailable. Re-enter the token and try again.';

function isDebridConfigurationFailure(value: unknown): boolean {
	if (value && typeof value === 'object') {
		const kind = (value as { kind?: unknown }).kind;
		if (kind === 'configuration' || kind === 'authentication') return true;
	}

	const message = value instanceof Error ? value.message : String(value ?? '');
	return /api token|stored token|credential|no enabled debrid download client/i.test(message);
}

function isAmbiguousDebridSubmission(value: unknown): boolean {
	const message = value instanceof Error ? value.message : String(value ?? '');
	return message.toLowerCase().includes(AMBIGUOUS_SUBMISSION_MARKER);
}

function normalizeReleaseKey(value: string | null | undefined): string {
	if (!value) return '';
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '')
		.trim();
}

function isImportRetryCandidate(queueItem: typeof downloadQueue.$inferSelect): boolean {
	if (queueItem.status !== 'failed') return false;

	const reason = queueItem.errorMessage?.toLowerCase() ?? '';

	// Positively identify import-phase failures by error message pattern.
	// This avoids misclassifying download-client errors (e.g. "Download limit
	// exceeded") that happen to have completedAt set because the client briefly
	// reported completion before post-processing failed.
	if (matchesImportError(reason)) return true;

	// If the download reached 100% AND the error is not a recognized import
	// error, it could still be worth trying an import retry when there is no
	// error message at all (the error may have been transient). However if the
	// client provided a specific non-import error, it is a download failure.
	const progress = Number(queueItem.progress ?? 0);
	if (Number.isFinite(progress) && progress >= 1 && !reason) return true;

	return false;
}

function isCompletedInClient(download: DownloadInfo): boolean {
	if (download.progress >= 1) return true;
	return ['completed', 'seeding', 'paused', 'postprocessing'].includes(download.status);
}

function matchesQueueItem(
	queueItem: typeof downloadQueue.$inferSelect,
	download: DownloadInfo
): boolean {
	const queueDownloadId = queueItem.downloadId?.toLowerCase();
	const queueInfoHash = queueItem.infoHash?.toLowerCase();
	const downloadHash = download.hash?.toLowerCase();
	const downloadId = download.id?.toLowerCase();

	if (queueDownloadId && (downloadHash === queueDownloadId || downloadId === queueDownloadId)) {
		return true;
	}

	if (queueInfoHash && (downloadHash === queueInfoHash || downloadId === queueInfoHash)) {
		return true;
	}

	return false;
}

function matchesQueueItemByTitleAndSize(
	queueItem: typeof downloadQueue.$inferSelect,
	download: DownloadInfo
): boolean {
	const queueKey = normalizeReleaseKey(queueItem.title);
	const downloadKey = normalizeReleaseKey(download.name);
	if (!queueKey || !downloadKey) return false;

	const titleMatches =
		queueKey === downloadKey ||
		(queueKey.length > 10 && downloadKey.includes(queueKey)) ||
		(downloadKey.length > 10 && queueKey.includes(downloadKey));
	if (!titleMatches) return false;

	const queueSize = Number(queueItem.size ?? 0);
	const downloadSize = Number(download.size ?? 0);
	if (
		!Number.isFinite(queueSize) ||
		queueSize <= 0 ||
		!Number.isFinite(downloadSize) ||
		downloadSize <= 0
	) {
		return true;
	}

	// Allow some tolerance for metadata differences across clients.
	const sizeDelta = Math.abs(downloadSize - queueSize);
	const tolerance = Math.max(queueSize * 0.1, 250 * 1024 * 1024);
	return sizeDelta <= tolerance;
}

function toSafeQueueItem(item: typeof downloadQueue.$inferSelect | undefined) {
	if (!item) return null;
	return {
		...item,
		downloadUrl: item.downloadUrl ? redactUrl(item.downloadUrl) : null
	};
}

/**
 * POST - Retry a failed queue item
 *
 * If the client still reports the item as completed, retry import first.
 * Otherwise, fall back to download retry (native client retry or re-add).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const { id } = params;

	try {
		// Get queue item
		const queueItem = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get();

		if (!queueItem) {
			throw error(404, 'Queue item not found');
		}

		// Only allow retrying failed downloads
		if (queueItem.status !== 'failed') {
			throw error(400, `Cannot retry download with status: ${queueItem.status}`);
		}

		if (queueItem.protocol === 'debrid') {
			let result: Awaited<ReturnType<DebridHandler['retry']>>;
			try {
				result = await new DebridHandler().retry(queueItem);
			} catch (retryError) {
				if (isAmbiguousDebridSubmission(retryError)) {
					return Response.json(
						{
							success: false,
							error: 'Provider submission outcome is unknown; automatic retry was refused.'
						},
						{ status: 409 }
					);
				}
				if (isDebridConfigurationFailure(retryError)) {
					return Response.json(
						{ success: false, error: DEBRID_CONFIGURATION_ERROR },
						{ status: 400 }
					);
				}
				throw retryError;
			}

			if (!result.success) {
				const message = result.error || 'Debrid retry failed';
				const status = isAmbiguousDebridSubmission(message)
					? 409
					: isDebridConfigurationFailure(message)
						? 400
						: 500;
				return Response.json({ success: false, error: message }, { status });
			}

			const updatedItem = await db
				.select()
				.from(downloadQueue)
				.where(eq(downloadQueue.id, id))
				.get();

			return Response.json({
				success: true,
				message: 'Download retry initiated',
				retryMode: 'debrid',
				queueItem: toSafeQueueItem(updatedItem)
			});
		}

		// Check if max import attempts exceeded
		const currentAttempts = queueItem.importAttempts || 0;
		if (currentAttempts >= MAX_IMPORT_ATTEMPTS) {
			throw error(
				400,
				`Max retry attempts (${MAX_IMPORT_ATTEMPTS}) exceeded. Consider re-searching for a different release.`
			);
		}

		// Get download client
		if (!queueItem.downloadClientId) {
			throw error(400, 'No download client associated with this queue item');
		}

		const client = await db
			.select()
			.from(downloadClients)
			.where(eq(downloadClients.id, queueItem.downloadClientId))
			.get();

		if (!client) {
			throw error(404, 'Download client not found');
		}

		// Get download client instance
		const clientInstance = await getDownloadClientManager().getClientInstance(client.id);
		if (!clientInstance) {
			throw error(500, 'Failed to get download client instance');
		}

		// For import-phase failures, prefer import retry before any re-download attempt.
		// 1) Reuse existing queue paths if available.
		// 2) Otherwise probe client for a completed item and reuse that path.
		if (isImportRetryCandidate(queueItem)) {
			let completedClientDownload: DownloadInfo | null = null;
			let downloads: DownloadInfo[] = [];

			try {
				downloads = await clientInstance.getDownloads();
				completedClientDownload =
					downloads.find(
						(download) => matchesQueueItem(queueItem, download) && isCompletedInClient(download)
					) ??
					downloads.find(
						(download) =>
							isCompletedInClient(download) && matchesQueueItemByTitleAndSize(queueItem, download)
					) ??
					null;
			} catch (clientLookupError) {
				if (clientLookupError instanceof Error && 'status' in clientLookupError) {
					throw clientLookupError;
				}

				logger.warn(
					{
						queueItemId: id,
						error:
							clientLookupError instanceof Error
								? clientLookupError.message
								: String(clientLookupError)
					},
					'Import retry probe failed; will use existing queue paths if available'
				);
			}

			const mappedOutputPath = completedClientDownload
				? getContentPath(
						completedClientDownload.savePath || completedClientDownload.contentPath,
						completedClientDownload.contentPath,
						client.downloadPathLocal,
						client.downloadPathRemote,
						client.tempPathLocal,
						client.tempPathRemote
					)
				: null;

			// Stored queue paths predate the #532 recovery guard and may hold a
			// client or category root left over from a metadata-less magnet.
			// Only reuse them when they survive the same safety check the
			// monitor applies. Paths probed from a completed client download
			// above are per-torrent and trusted.
			const storedOutputPath = queueItem.outputPath || queueItem.clientDownloadPath || null;
			const safeStoredOutputPath =
				storedOutputPath &&
				(await isSafeRecoveryCandidate(storedOutputPath, queueItem, client, downloads))
					? storedOutputPath
					: null;

			if (mappedOutputPath || safeStoredOutputPath) {
				const now = new Date().toISOString();
				const existingProgress = Number(queueItem.progress ?? 0);
				const normalizedExistingProgress = Number.isFinite(existingProgress) ? existingProgress : 0;
				const mergedProgress = completedClientDownload
					? Math.max(normalizedExistingProgress, completedClientDownload.progress)
					: Math.max(normalizedExistingProgress, 1);

				await db
					.update(downloadQueue)
					.set({
						status: 'completed',
						downloadId: completedClientDownload?.id || queueItem.downloadId,
						infoHash: completedClientDownload?.hash || queueItem.infoHash,
						progress: mergedProgress.toString(),
						downloadSpeed: completedClientDownload?.downloadSpeed ?? 0,
						uploadSpeed: completedClientDownload?.uploadSpeed ?? 0,
						eta: completedClientDownload?.eta ?? null,
						clientDownloadPath:
							completedClientDownload?.contentPath ||
							completedClientDownload?.savePath ||
							queueItem.clientDownloadPath,
						outputPath: mappedOutputPath || safeStoredOutputPath,
						errorMessage: null,
						completedAt: queueItem.completedAt || now,
						lastAttemptAt: now
					})
					.where(eq(downloadQueue.id, id));

				const importResult = await getImportService().requestImport(id);
				if (importResult.status === 'failed') {
					throw error(
						400,
						importResult.reason || 'Import retry failed. Consider re-searching and grabbing again.'
					);
				}

				const updatedItem = await db
					.select()
					.from(downloadQueue)
					.where(eq(downloadQueue.id, id))
					.get();
				const safeItem = toSafeQueueItem(updatedItem);
				const message =
					importResult.status === 'pending_retry'
						? 'Import retry queued. Waiting for download path to become available.'
						: 'Import retry initiated';

				logger.info(
					{
						queueItemId: id,
						importResult: importResult.status,
						source: completedClientDownload ? 'client-completed' : 'stored-queue-path'
					},
					'Import retry initiated for failed queue item'
				);

				return Response.json({
					success: true,
					message,
					retryMode: 'import',
					importStatus: importResult.status,
					queueItem: safeItem
				});
			}

			// If still no usable path, try filesystem recovery
			if (
				!mappedOutputPath &&
				!safeStoredOutputPath &&
				client.downloadPathLocal &&
				queueItem.title
			) {
				const fsCategory = (queueItem.seriesId ? client.tvCategory : client.movieCategory) ?? '';
				// Reuse the shared path reconstruction; fall back to the queue title
				// when the stored outputPath has no usable last component.
				const candidatePath =
					buildTorrentRecoveryPath(
						queueItem.outputPath || '',
						client.downloadPathLocal,
						fsCategory
					) ?? `${client.downloadPathLocal.replace(/\/+$/, '')}/${fsCategory}/${queueItem.title}`;

				// A reconstructed path is a guess: never import from a
				// client/category root or a directory another active download
				// owns (#532).
				if (await isSafeRecoveryCandidate(candidatePath, queueItem, client, downloads)) {
					// Found! Update and import
					await db
						.update(downloadQueue)
						.set({
							outputPath: candidatePath,
							clientDownloadPath: candidatePath,
							status: 'completed',
							completedAt: queueItem.completedAt || new Date().toISOString(),
							errorMessage: null,
							importAttempts: 0,
							lastAttemptAt: new Date().toISOString()
						})
						.where(eq(downloadQueue.id, id));

					const importResult = await getImportService().requestImport(id);
					return Response.json({
						success: true,
						message: 'Files located and import initiated',
						retryMode: 'import',
						importStatus: importResult.status
					});
				}
				// Not safe or not found, fall through to re-download
			}
		}

		let newInfoHash: string | undefined;

		// We need either a magnet URL or download URL to re-download
		const downloadUrl = queueItem.magnetUrl || queueItem.downloadUrl;
		if (!downloadUrl) {
			throw error(
				400,
				'No download URL available for retry. Consider re-searching and grabbing again.'
			);
		}

		// Re-arm the acquisition authority before touching the client: the
		// retried transport must reserve its slot like any other acquisition,
		// or a concurrent automatic grab can claim it.
		const rearm = await acquisitionService.rearmForQueueId(id);
		if (!rearm.ok) {
			return Response.json({ success: false, error: rearm.reason }, { status: 409 });
		}

		// Try native client retry first (SABnzbd/NZBGet can retry from history cache)
		if (clientInstance.retryDownload && queueItem.downloadId) {
			try {
				newInfoHash = await clientInstance.retryDownload(queueItem.downloadId);
				logger.info({ id, newInfoHash }, 'Native retry succeeded');
			} catch (retryError) {
				logger.warn(
					{
						id,
						error: retryError instanceof Error ? retryError.message : String(retryError)
					},
					'Native retry failed, falling back to re-add'
				);
				// Fall through to re-add approach
			}
		}

		// Fall back to re-adding the download if native retry didn't work
		if (!newInfoHash) {
			// Determine category based on media type
			const clientConfig = await getDownloadClientManager().getClient(client.id);
			const category = queueItem.movieId
				? (clientConfig?.movieCategory ?? 'movies')
				: (clientConfig?.tvCategory ?? 'tv');

			// Re-add to download client
			newInfoHash = await clientInstance.addDownload({
				magnetUri: queueItem.magnetUrl || undefined,
				downloadUrl: queueItem.magnetUrl ? undefined : queueItem.downloadUrl || undefined,
				category,
				title: queueItem.title
			});
		}

		await db
			.update(downloadQueue)
			.set({
				status: 'queued',
				downloadId: newInfoHash || queueItem.downloadId,
				infoHash: newInfoHash || queueItem.infoHash,
				progress: '0',
				downloadSpeed: 0,
				uploadSpeed: 0,
				eta: null,
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				importAttempts: (queueItem.importAttempts || 0) + 1,
				lastAttemptAt: new Date().toISOString()
			})
			.where(eq(downloadQueue.id, id));

		// Get updated item
		const updatedItem = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get();

		// Redact sensitive URLs before returning
		const safeItem = toSafeQueueItem(updatedItem);

		return Response.json({
			success: true,
			message: 'Download retry initiated',
			queueItem: safeItem
		});
	} catch (err) {
		if (err instanceof Error && 'status' in err) throw err;
		logger.error('Error retrying download', err instanceof Error ? err : undefined);
		const message = err instanceof Error ? err.message : 'Failed to retry download';
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};

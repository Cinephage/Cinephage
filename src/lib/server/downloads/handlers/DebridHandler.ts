import { getInstantFileEvidence } from '#lib/server/languages/debrid-evidence.js';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, episodes } from '#lib/server/db/schema.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import {
	isDebridError,
	type DebridAdapter,
	type SubmissionInput
} from '#lib/server/downloadClients/debrid/debrid-adapter.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { recheckResolvedIdentity } from '../identity-recheck.js';
import { isImportedQueueStatus } from '#lib/types/queue.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getDownloadResolutionService } from '../DownloadResolutionService.js';
import type { GrabRequest, HandlerResult, ResolvedContext } from '../grab-types.js';

const logger = createChildLogger({ module: 'DebridHandler' });
const parser = new ReleaseParser();
const INTENT_PREFIX = 'debrid-intent:';
const AMBIGUOUS_MARKER = '[ambiguous_submission]';

type QueueRow = typeof downloadQueue.$inferSelect;

interface PreparedSubmission {
	input: SubmissionInput;
	infoHash: string;
	magnetUrl?: string;
}

const submissionLocks = new Map<string, Promise<void>>();

async function withSubmissionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = submissionLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	submissionLocks.set(key, tail);
	await previous;

	try {
		return await operation();
	} finally {
		release();
		if (submissionLocks.get(key) === tail) submissionLocks.delete(key);
	}
}

export class DebridHandler {
	async handle(request: GrabRequest, resolved: ResolvedContext): Promise<HandlerResult> {
		if (request.release.protocol !== 'torrent') {
			return { success: false, error: 'Debrid acquisition requires a torrent release' };
		}

		const prepared = await this.prepareSubmission(request.release);
		if (!prepared.success) return prepared.result;
		const mediaType: 'movie' | 'tv' | undefined = resolved.movieId
			? 'movie'
			: resolved.seriesId
				? 'tv'
				: undefined;
		const initiallySelected = await getDownloadClientManager().getDebridClientForAcquisition(
			undefined,
			mediaType
		);
		if (!initiallySelected) return this.noUsableClient();

		return withSubmissionLock(prepared.value.infoHash.toLowerCase(), async () => {
			// Post-resolution identity recheck: the canonical info hash is only
			// known now. Re-verify it against active intents, the live queue, and
			// import history before submitting to the debrid provider — mirrors
			// TorrentHandler. Without this, re-grabbing an already-imported or
			// in-flight torrent via debrid slipped through.
			if (request.options.intentId) {
				const recheck = await recheckResolvedIdentity(
					request.options.intentId,
					prepared.value.infoHash
				);
				if (recheck.blocked) {
					acquisitionService.cancelIntent(request.options.intentId, recheck.reason);
					logger.info(
						{
							title: request.release.title,
							infoHash: prepared.value.infoHash,
							reason: recheck.reason
						},
						'[DebridHandler] Blocked duplicate after metadata resolution'
					);
					return { success: false, error: recheck.reason };
				}
			}

			const existing = await this.findExistingIntent(prepared.value.infoHash);
			if (existing) return this.returnOrReconcileExisting(existing, prepared.value.infoHash);

			const parsed = parser.parse(request.release.title);
			// Best-effort tier-3 evidence: cached file listing from the debrid
			// provider (no download); null when uncached/unsupported.
			const instantEvidence = await getInstantFileEvidence(prepared.value.infoHash);
			const queueItem = await downloadMonitor.addToQueue({
				downloadClientId: initiallySelected.client.id,
				downloadId: `${INTENT_PREFIX}${prepared.value.infoHash.toLowerCase()}`,
				infoHash: prepared.value.infoHash,
				title: request.release.title,
				indexerId: request.release.indexerId,
				indexerName: request.release.indexerName,
				downloadUrl: request.release.downloadUrl,
				magnetUrl: prepared.value.magnetUrl ?? request.release.magnetUrl,
				protocol: 'debrid',
				movieId: resolved.movieId,
				seriesId: resolved.seriesId,
				episodeIds: resolved.episodeIds,
				seasonNumber: resolved.seasonNumber,
				quality: {
					resolution: parsed.resolution ?? undefined,
					source: parsed.source ?? undefined,
					codec: parsed.codec ?? undefined,
					hdr: parsed.hdr ?? undefined,
					languages: parsed.languages.length > 0 ? parsed.languages : undefined,
					fileLanguages:
						instantEvidence && instantEvidence.languages.length > 0
							? instantEvidence.languages
							: undefined
				},
				size: request.release.size,
				releaseGroup: parsed.releaseGroup ?? undefined,
				isAutomatic: request.options.isAutomatic,
				isUpgrade: request.options.isUpgrade
			});

			return this.reconcileOrSubmit(
				queueItem.id,
				prepared.value,
				initiallySelected.client,
				initiallySelected.adapter,
				false
			);
		});
	}

	/** Retry a failed debrid row using its original client and source identity. */
	async retry(queueItem: QueueRow): Promise<HandlerResult> {
		if (queueItem.protocol !== 'debrid') {
			return { success: false, error: 'Queue item is not a debrid acquisition' };
		}

		const prepared = await this.prepareSubmission({
			title: queueItem.title,
			protocol: 'torrent',
			downloadUrl: queueItem.downloadUrl ?? undefined,
			magnetUrl: queueItem.magnetUrl ?? undefined,
			infoHash: queueItem.infoHash ?? undefined,
			indexerId: queueItem.indexerId ?? undefined
		});
		if (!prepared.success) return prepared.result;

		return withSubmissionLock(prepared.value.infoHash.toLowerCase(), async () => {
			let current = await db
				.select()
				.from(downloadQueue)
				.where(eq(downloadQueue.id, queueItem.id))
				.get();
			if (!current) return { success: false, error: 'Queue item not found' };

			// Re-arm the acquisition authority: the retry must reserve its slot
			// before resubmitting, exactly like a fresh grab.
			const rearm = await acquisitionService.rearmForQueueId(current.id);
			if (!rearm.ok) {
				return { success: false, error: rearm.reason };
			}

			current = await this.restoreMissingSeriesTarget(current);

			const selected = await getDownloadClientManager().getDebridClientForAcquisition(
				current.downloadClientId
			);
			if (!selected) return this.noUsableClient();

			if (this.isAmbiguous(current)) {
				return this.reconcileAmbiguous(current, selected.client, selected.adapter);
			}

			if (!current.downloadId.startsWith(INTENT_PREFIX) && current.status !== 'failed') {
				return this.successResult(current, selected.client, true);
			}

			return this.reconcileOrSubmit(
				current.id,
				prepared.value,
				selected.client,
				selected.adapter,
				true
			);
		});
	}

	private async restoreMissingSeriesTarget(queueItem: QueueRow): Promise<QueueRow> {
		if (!queueItem.seriesId || (queueItem.episodeIds?.length ?? 0) > 0) return queueItem;

		const targetEpisodes = await db
			.select({ id: episodes.id })
			.from(episodes)
			.where(
				and(
					eq(episodes.seriesId, queueItem.seriesId),
					eq(episodes.hasFile, false),
					eq(episodes.monitored, true),
					ne(episodes.seasonNumber, 0)
				)
			)
			.all();
		const episodeIds = targetEpisodes.map((episode) => episode.id);
		if (episodeIds.length === 0) return queueItem;

		await db
			.update(downloadQueue)
			.set({ episodeIds })
			.where(eq(downloadQueue.id, queueItem.id))
			.run();
		return { ...queueItem, episodeIds };
	}

	private async prepareSubmission(
		release: Pick<
			GrabRequest['release'],
			'title' | 'protocol' | 'downloadUrl' | 'magnetUrl' | 'infoHash' | 'indexerId' | 'commentsUrl'
		>
	): Promise<
		{ success: true; value: PreparedSubmission } | { success: false; result: HandlerResult }
	> {
		const fail = (error: string) => ({
			success: false as const,
			result: { success: false, error }
		});
		const resolved = await getDownloadResolutionService().resolve({
			downloadUrl: release.downloadUrl,
			magnetUrl: release.magnetUrl,
			infoHash: release.infoHash,
			indexerId: release.indexerId,
			title: release.title,
			commentsUrl: release.commentsUrl
		});

		if (!resolved.success)
			return fail(`Failed to resolve download: ${resolved.error ?? 'unknown resolution error'}`);

		const infoHash = resolved.infoHash?.trim().toLowerCase();
		if (!infoHash) return fail('Debrid acquisition requires a resolved torrent info hash');
		if (!/^[a-f0-9]{40}$/.test(infoHash))
			return fail('Debrid acquisition requires a valid 40-character torrent info hash');

		let input: SubmissionInput;
		if (resolved.torrentFile) {
			const baseName = release.title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'download';
			input = {
				kind: 'torrent',
				bytes: resolved.torrentFile,
				filename: `${baseName}.torrent`
			};
		} else if (resolved.magnetUrl?.startsWith('magnet:')) {
			input = { kind: 'magnet', magnet: resolved.magnetUrl };
		} else return fail('Debrid acquisition requires a resolved magnet or torrent file');

		return { success: true, value: { input, infoHash, magnetUrl: resolved.magnetUrl } };
	}

	private async findExistingIntent(infoHash: string): Promise<QueueRow | undefined> {
		return db
			.select()
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.protocol, 'debrid'),
					eq(downloadQueue.infoHash, infoHash),
					ne(downloadQueue.status, 'removed')
				)
			)
			.limit(1)
			.get();
	}

	private async returnOrReconcileExisting(
		queueItem: QueueRow,
		infoHash: string
	): Promise<HandlerResult> {
		const selected = await getDownloadClientManager().getDebridClientForAcquisition(
			queueItem.downloadClientId
		);
		if (!selected) return this.noUsableClient();

		if (this.isAmbiguous(queueItem) || queueItem.downloadId.startsWith(INTENT_PREFIX)) {
			return this.reconcileAmbiguous(queueItem, selected.client, selected.adapter);
		}

		if (queueItem.status === 'failed') {
			return {
				success: false,
				error: queueItem.errorMessage ?? `Debrid acquisition for ${infoHash} previously failed`
			};
		}

		if (isImportedQueueStatus(queueItem.status)) {
			return {
				success: false,
				error: `Release ${infoHash} was already imported — remove it first or grab a different release`
			};
		}

		return this.successResult(queueItem, selected.client, true);
	}

	private async reconcileAmbiguous(
		queueItem: QueueRow,
		client: { id: string; name: string },
		adapter: DebridAdapter
	): Promise<HandlerResult> {
		const infoHash = queueItem.infoHash;
		if (!infoHash) return { success: false, error: `${AMBIGUOUS_MARKER} Missing torrent hash` };

		try {
			const providerItemId = await adapter.findByInfoHash(infoHash);
			if (providerItemId) {
				const completed = await downloadMonitor.completeDebridSubmission(
					queueItem.id,
					providerItemId
				);
				return completed
					? this.successResult(completed, client, true)
					: { success: false, error: 'Failed to update debrid queue identity' };
			}
		} catch (error) {
			logger.warn(
				{ queueId: queueItem.id, error: this.safeError(error) },
				'Debrid submission reconciliation failed'
			);
		}

		const message = `${AMBIGUOUS_MARKER} Submission outcome is unknown; refusing blind resubmission`;
		if (!this.isAmbiguous(queueItem)) await downloadMonitor.markFailed(queueItem.id, message);
		return { success: false, error: message };
	}

	private async reconcileOrSubmit(
		queueId: string,
		prepared: PreparedSubmission,
		client: { id: string; name: string },
		adapter: DebridAdapter,
		isRetry: boolean
	): Promise<HandlerResult> {
		try {
			if (isRetry) {
				const intent = await downloadMonitor.prepareDebridSubmissionIntent(
					queueId,
					prepared.infoHash
				);
				if (!intent) return { success: false, error: 'Queue item not found' };
			}

			const existingProviderId = await adapter.findByInfoHash(prepared.infoHash);
			if (existingProviderId) {
				const completed = await downloadMonitor.completeDebridSubmission(
					queueId,
					existingProviderId
				);
				return completed
					? this.successResult(completed, client, true)
					: { success: false, error: 'Failed to update debrid queue identity' };
			}

			const submitted = await adapter.submit(prepared.input);
			const completed = await downloadMonitor.completeDebridSubmission(
				queueId,
				submitted.providerItemId
			);
			if (!completed) return { success: false, error: 'Failed to update debrid queue identity' };

			return this.successResult(completed, client, false);
		} catch (error) {
			const ambiguous = isDebridError(error) && error.kind === 'ambiguous_submission';
			const safeMessage = this.safeError(error);
			const persistedMessage = ambiguous
				? `${AMBIGUOUS_MARKER} ${safeMessage}`
				: `Debrid ${isRetry ? 'retry' : 'submission'} failed: ${safeMessage}`;
			await downloadMonitor.markFailed(queueId, persistedMessage);
			return { success: false, error: persistedMessage };
		}
	}

	private successResult(
		queueItem: Pick<QueueRow, 'id'> & { infoHash?: string | null },
		client: { id: string; name: string },
		wasDuplicate: boolean
	): HandlerResult {
		return {
			success: true,
			queueId: queueItem.id,
			hash: queueItem.infoHash ?? undefined,
			clientId: client.id,
			clientName: client.name,
			category: 'debrid',
			wasDuplicate
		};
	}

	private noUsableClient(): HandlerResult {
		return {
			success: false,
			error: 'No enabled debrid download client with a usable stored API token configured'
		};
	}

	private isAmbiguous(queueItem: Pick<QueueRow, 'errorMessage'>): boolean {
		return queueItem.errorMessage?.includes(AMBIGUOUS_MARKER) ?? false;
	}

	private safeError(error: unknown): string {
		if (isDebridError(error)) return error.redactedMessage;
		return 'Provider operation failed';
	}
}

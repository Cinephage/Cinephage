import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import {
	downloadQueue,
	downloadHistory,
	movies,
	series,
	downloadClients
} from '#lib/server/db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { upsertQueueTombstoneFromQueueItem } from '#lib/server/downloadClients/monitoring/QueueTombstoneService.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'QueueItemApi', logDomain: 'downloads' });

const DEFAULT_QUEUE_REMOVE_CLIENT_TIMEOUT_MS = 3000;

function getQueueRemoveClientTimeoutMs(): number {
	const raw = process.env.QUEUE_REMOVE_CLIENT_TIMEOUT_MS;
	if (!raw) {
		return DEFAULT_QUEUE_REMOVE_CLIENT_TIMEOUT_MS;
	}

	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_QUEUE_REMOVE_CLIENT_TIMEOUT_MS;
	}

	return Math.round(parsed);
}

async function writeRemovedHistory(queueItem: typeof downloadQueue.$inferSelect): Promise<void> {
	if (queueItem.status === 'failed') {
		const historyConditions = [
			eq(downloadHistory.status, 'failed'),
			eq(downloadHistory.title, queueItem.title)
		];

		if (queueItem.addedAt) {
			historyConditions.push(eq(downloadHistory.grabbedAt, queueItem.addedAt));
		}

		if (queueItem.downloadId) {
			historyConditions.push(eq(downloadHistory.downloadId, queueItem.downloadId));
		}

		if (queueItem.downloadClientId) {
			historyConditions.push(eq(downloadHistory.downloadClientId, queueItem.downloadClientId));
		}

		const existingFailedHistory = await db
			.select({ id: downloadHistory.id })
			.from(downloadHistory)
			.where(and(...historyConditions))
			.orderBy(desc(downloadHistory.createdAt))
			.limit(1)
			.get();

		if (existingFailedHistory) {
			await db
				.update(downloadHistory)
				.set({
					status: 'removed',
					statusReason: null,
					size: queueItem.size,
					quality: queueItem.quality,
					releaseGroup: queueItem.releaseGroup,
					infoHash: queueItem.infoHash,
					completedAt: queueItem.completedAt
				})
				.where(eq(downloadHistory.id, existingFailedHistory.id));
			return;
		}
	}

	await db.insert(downloadHistory).values({
		downloadClientId: queueItem.downloadClientId,
		downloadId: queueItem.downloadId,
		title: queueItem.title,
		status: 'removed',
		movieId: queueItem.movieId,
		seriesId: queueItem.seriesId,
		seasonNumber: queueItem.seasonNumber,
		episodeIds: queueItem.episodeIds,
		indexerId: queueItem.indexerId,
		indexerName: queueItem.indexerName,
		protocol: queueItem.protocol,
		size: queueItem.size,
		quality: queueItem.quality,
		releaseGroup: queueItem.releaseGroup,
		infoHash: queueItem.infoHash,
		grabbedAt: queueItem.addedAt,
		completedAt: queueItem.completedAt,
		importedAt: queueItem.importedAt,
		createdAt: new Date().toISOString()
	});
}

function isDownloadClientUnavailableError(err: unknown): boolean {
	const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

	return (
		message.includes('unavailable') ||
		message.includes('timeout') ||
		message.includes('timed out') ||
		message.includes('fetch failed') ||
		message.includes('network') ||
		message.includes('econnrefused') ||
		message.includes('ehostunreach') ||
		message.includes('enotfound') ||
		message.includes('socket')
	);
}

async function removeDownloadWithTimeout(
	clientInstance: { removeDownload: (id: string, deleteFiles?: boolean) => Promise<void> },
	clientDownloadId: string,
	deleteFiles: boolean,
	timeoutMs = getQueueRemoveClientTimeoutMs()
): Promise<void> {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

	try {
		await Promise.race([
			clientInstance.removeDownload(clientDownloadId, deleteFiles),
			new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(new Error(`Download client remove timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			})
		]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

/**
 * GET - Get a single queue item by ID
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const { id } = params;

	try {
		const queueItem = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get();

		if (!queueItem) {
			throw error(404, 'Queue item not found');
		}

		// Get associated media info
		let mediaInfo = null;
		if (queueItem.movieId) {
			const movie = await db
				.select({ id: movies.id, title: movies.title, year: movies.year })
				.from(movies)
				.where(eq(movies.id, queueItem.movieId))
				.get();
			mediaInfo = { type: 'movie', ...movie };
		} else if (queueItem.seriesId) {
			const seriesData = await db
				.select({ id: series.id, title: series.title, year: series.year })
				.from(series)
				.where(eq(series.id, queueItem.seriesId))
				.get();
			mediaInfo = { type: 'series', ...seriesData };
		}

		// Get download client info
		let clientInfo = null;
		if (queueItem.downloadClientId) {
			const client = await db
				.select({
					id: downloadClients.id,
					name: downloadClients.name,
					implementation: downloadClients.implementation
				})
				.from(downloadClients)
				.where(eq(downloadClients.id, queueItem.downloadClientId))
				.get();
			clientInfo = client;
		}

		return Response.json({
			...queueItem,
			media: mediaInfo,
			downloadClient: clientInfo
		});
	} catch (err) {
		if (err instanceof Error && 'status' in err) throw err;
		logger.error('Error fetching queue item', err instanceof Error ? err : undefined);
		throw error(500, 'Failed to fetch queue item');
	}
};

/**
 * PATCH - Update a queue item (e.g., pause, resume, change priority)
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const { id } = params;

	try {
		const body = await request.json();
		const { action } = body as { action?: string };

		// Verify item exists
		const queueItem = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get();

		if (!queueItem) {
			throw error(404, 'Queue item not found');
		}

		if (queueItem.protocol === 'debrid' && (action === 'pause' || action === 'resume')) {
			const actionLabel = action === 'pause' ? 'Pause' : 'Resume';
			throw error(400, `${actionLabel} is not supported for debrid downloads`);
		}

		// Handle different actions using downloadMonitor which emits SSE events
		if (action === 'pause') {
			await downloadMonitor.pauseDownload(id);
			return Response.json({ success: true, action: 'paused' });
		}

		if (action === 'resume') {
			await downloadMonitor.resumeDownload(id);
			return Response.json({ success: true, action: 'resumed' });
		}

		throw error(400, 'No valid action specified');
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		logger.error('Error updating queue item', err instanceof Error ? err : undefined);
		throw error(500, 'Failed to update queue item');
	}
};

/**
 * DELETE - Remove a queue item from queue and optionally from download client
 */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const { id } = params;
	const removeFromClient = url.searchParams.get('removeFromClient') !== 'false';
	const deleteFiles = url.searchParams.get('deleteFiles') === 'true';
	const addToBlocklist = url.searchParams.get('blocklist') === 'true';

	try {
		// Get queue item
		const queueItem = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get();

		if (!queueItem) {
			throw error(404, 'Queue item not found');
		}

		let removedFromClient = false;

		// Remove from download client first when requested.
		// If the client is unavailable, fall back to local removal and leave a tombstone.
		if (removeFromClient) {
			if (!queueItem.downloadClientId) {
				throw error(400, 'Queue item is missing a download client');
			}

			// Torrents usually use infoHash while usenet clients use downloadId (e.g. nzo_id).
			const isTorrent = queueItem.protocol === 'torrent';
			const clientDownloadId = isTorrent
				? queueItem.infoHash || queueItem.downloadId
				: queueItem.downloadId || queueItem.infoHash;
			if (!clientDownloadId) {
				logger.warn(
					{
						queueId: queueItem.id,
						title: queueItem.title
					},
					'Queue item missing client identifier; continuing with local removal only'
				);
			} else {
				const clientInstance = await getDownloadClientManager().getClientInstance(
					queueItem.downloadClientId
				);
				if (!clientInstance) {
					logger.warn(
						{
							queueId: queueItem.id,
							title: queueItem.title,
							downloadClientId: queueItem.downloadClientId
						},
						'Download client unavailable during queue removal; falling back to local-only removal'
					);
				} else {
					try {
						await removeDownloadWithTimeout(clientInstance, clientDownloadId, deleteFiles);
						removedFromClient = true;
					} catch (removeError) {
						if (!isDownloadClientUnavailableError(removeError)) {
							throw removeError;
						}

						logger.warn(
							{
								queueId: queueItem.id,
								title: queueItem.title,
								downloadClientId: queueItem.downloadClientId,
								error: removeError instanceof Error ? removeError.message : String(removeError)
							},
							'Download client unavailable during queue removal; falling back to local-only removal'
						);
					}
				}
			}
		}

		// Add to blocklist if requested. Not gated on infoHash - usenet queue
		// items never have one, and the blocklist service matches on title/
		// indexer/quality/size too (see BlocklistService.addToBlocklist).
		if (addToBlocklist) {
			try {
				const { blocklistService } =
					await import('#lib/server/monitoring/specifications/BlocklistSpecification.js');
				await blocklistService.addToBlocklist(
					{
						title: queueItem.title,
						infoHash: queueItem.infoHash ?? undefined,
						indexerId: queueItem.indexerId ?? undefined,
						quality: queueItem.quality ?? undefined,
						size: queueItem.size ?? undefined,
						protocol: queueItem.protocol
					},
					{
						movieId: queueItem.movieId ?? undefined,
						seriesId: queueItem.seriesId ?? undefined,
						episodeIds: queueItem.episodeIds ?? undefined,
						reason: 'manual',
						message: 'Manually blocklisted from the queue/history'
					}
				);
			} catch (blocklistError) {
				logger.warn(
					{
						queueId: queueItem.id,
						title: queueItem.title,
						error: blocklistError instanceof Error ? blocklistError.message : String(blocklistError)
					},
					'Failed to add release to blocklist'
				);
			}
		}

		// Add/refresh a suppression tombstone when local state is removed without confirmed
		// removal from the remote client.
		if (!removeFromClient || !removedFromClient) {
			try {
				await upsertQueueTombstoneFromQueueItem(
					queueItem,
					removeFromClient
						? 'local_remove_client_unavailable'
						: 'local_remove_without_client_delete'
				);
			} catch (tombstoneError) {
				logger.warn(
					{
						queueId: queueItem.id,
						title: queueItem.title,
						error: tombstoneError instanceof Error ? tombstoneError.message : String(tombstoneError)
					},
					'Failed to upsert queue tombstone'
				);
			}
		}

		// Preserve the original failed attempt as a single history record when a user removes it.
		await writeRemovedHistory(queueItem);

		// Delete from queue. User-initiated removal: release the acquisition's
		// slot reservations BEFORE the row vanishes (the lookup is by queue id).
		acquisitionService.cancelByQueueId(id, 'removed from queue');
		await db.delete(downloadQueue).where(eq(downloadQueue.id, id));

		return Response.json({ success: true, message: 'Queue item removed' });
	} catch (err) {
		if (err instanceof Error && 'status' in err) throw err;
		logger.error('Error deleting queue item', err instanceof Error ? err : undefined);
		throw error(500, 'Failed to delete queue item');
	}
};

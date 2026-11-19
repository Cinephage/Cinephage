/**
 * What happens to an entity's footprint when it leaves the library: its files
 * on disk and its queued downloads.
 *
 * The movie and series DELETE handlers each carried these two blocks. The disk
 * block holds a safety rule — an entity tracked AT the root must remove its own
 * files, never the directory, or the whole library goes with it — and a rule
 * that important should not exist twice.
 */

import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadQueue } from '#lib/server/db/schema.js';
import {
	deleteDirectoryWithinRoot,
	deleteFilesWithinRoot,
	namesRootItself
} from '#lib/server/filesystem/delete-helpers.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryRemoval', logDomain: 'scans' });

export interface EntityOnDisk {
	/** Used in log lines only. */
	kind: 'movie' | 'series';
	rootFolderPath: string | null;
	entityPath: string | null;
	/** File paths relative to `entityPath`. */
	relativePaths: string[];
}

/**
 * Delete the entity's folder, or only its own files when the entity is tracked
 * at the library root itself.
 */
export async function removeEntityFromDisk(
	entity: EntityOnDisk
): Promise<'folder' | 'files' | 'none'> {
	const { rootFolderPath, entityPath } = entity;
	if (!rootFolderPath || !entityPath) return 'none';

	if (namesRootItself(rootFolderPath, entityPath)) {
		const removed = await deleteFilesWithinRoot(
			rootFolderPath,
			entity.relativePaths.map((relativePath) => join(entityPath, relativePath))
		);
		logger.debug(
			{ kind: entity.kind, count: removed.length },
			'[API] Removed root-level files without deleting the library root'
		);
		return 'files';
	}

	const folder = await deleteDirectoryWithinRoot(rootFolderPath, entityPath);
	logger.debug(
		{ kind: entity.kind, folder },
		'[API] Removed library entity folder and all contents'
	);
	return 'folder';
}

export interface QueuedDownload {
	id: string;
	downloadClientId: string | null;
	protocol: string | null;
	infoHash: string | null;
	downloadId: string | null;
}

/**
 * Stop each queued download on its client, release the acquisition slot, then
 * drop the queue row. Cancelling the intent first keeps the slot from leaking
 * until restart.
 */
export async function cancelQueuedDownloads(items: QueuedDownload[]): Promise<void> {
	for (const item of items) {
		if (item.downloadClientId) {
			try {
				// Torrent clients key on the hash; usenet on the download id.
				const clientDownloadId =
					item.protocol === 'torrent'
						? item.infoHash || item.downloadId
						: item.downloadId || item.infoHash;

				if (clientDownloadId) {
					const clientInstance = await getDownloadClientManager().getClientInstance(
						item.downloadClientId
					);
					if (clientInstance) {
						await clientInstance.removeDownload(clientDownloadId, true);
					}
				}
			} catch (err) {
				logger.warn(
					{ queueItemId: item.id, error: err instanceof Error ? err.message : 'Unknown' },
					'[API] Failed to remove download from client'
				);
			}
		}

		acquisitionService.cancelByQueueId(item.id, 'media removed from library');
		await db.delete(downloadQueue).where(eq(downloadQueue.id, item.id));
	}
}

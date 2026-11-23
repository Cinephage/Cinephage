import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, rootFolders, trackFiles, tracks } from '#lib/server/db/schema.js';
import { isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { deletePhysicalFile } from '#lib/server/downloadClients/import/FileTransfer.js';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/MediaBrowserNotifier.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';

const logger = createChildLogger({ module: 'MusicFileService', logDomain: 'scans' });

export interface RemovedMusicFile {
	albumId: string;
	trackId: string | null;
	path: string | null;
}

/**
 * Deleting one audio file, the way a movie page deletes one file.
 *
 * Disk first, then the row, then the two cached flags that say whether the
 * track and the album still have anything on disk. A read-only root folder is
 * a hard stop, and a path outside the managed roots is never unlinked.
 */
export class MusicFileService {
	async removeFile(fileId: string): Promise<RemovedMusicFile | null> {
		const row = db
			.select({
				id: trackFiles.id,
				albumId: trackFiles.albumId,
				trackId: trackFiles.trackId,
				relativePath: trackFiles.relativePath,
				albumPath: albums.path,
				rootPath: rootFolders.path,
				readOnly: rootFolders.readOnly
			})
			.from(trackFiles)
			.innerJoin(albums, eq(trackFiles.albumId, albums.id))
			.leftJoin(rootFolders, eq(albums.rootFolderId, rootFolders.id))
			.where(eq(trackFiles.id, fileId))
			.get();

		if (!row) return null;
		if (row.readOnly) {
			throw new ValidationError('Cannot delete files from a read-only folder');
		}

		const fullPath = row.albumPath ? join(row.albumPath, row.relativePath) : null;

		let physicalDeleted = true;
		if (fullPath && (await isPathInsideManagedRoot(fullPath))) {
			try {
				const { recycleEnabled } = await getFileManagementSettings();
				await deletePhysicalFile(fullPath, recycleEnabled, row.rootPath ?? row.albumPath ?? '.');
			} catch (error) {
				physicalDeleted = false;
				logger.warn(
					{ fullPath, err: error instanceof Error ? error.message : String(error) },
					'[MusicFile] Could not delete file from disk'
				);
			}
		} else if (fullPath) {
			physicalDeleted = false;
			logger.warn({ fullPath }, '[MusicFile] Refusing to unlink a path outside managed roots');
		}

		if (!physicalDeleted) {
			// Keep the row: forgetting a file that is still on disk makes the
			// track unplayable with no record of why.
			throw new ValidationError('Could not remove the file from disk');
		}

		db.delete(trackFiles).where(eq(trackFiles.id, fileId)).run();

		if (row.trackId) {
			const remainingForTrack = db
				.select({ id: trackFiles.id })
				.from(trackFiles)
				.where(eq(trackFiles.trackId, row.trackId))
				.limit(1)
				.all();
			if (remainingForTrack.length === 0) {
				db.update(tracks).set({ hasFile: false }).where(eq(tracks.id, row.trackId)).run();
			}
		}

		const remainingForAlbum = db
			.select({ id: trackFiles.id })
			.from(trackFiles)
			.where(eq(trackFiles.albumId, row.albumId))
			.limit(1)
			.all();
		db.update(albums)
			.set({ hasFile: remainingForAlbum.length > 0 })
			.where(eq(albums.id, row.albumId))
			.run();

		if (fullPath) {
			getMediaBrowserNotifier().queueUpdate(fullPath, 'Deleted', 'delete');
		}

		logger.info({ fileId, albumId: row.albumId, fullPath }, '[MusicFile] File removed');

		return { albumId: row.albumId, trackId: row.trackId, path: fullPath };
	}
}

export const musicFileService = new MusicFileService();

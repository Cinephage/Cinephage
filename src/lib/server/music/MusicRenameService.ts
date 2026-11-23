/**
 * Rename preview + execution for music files.
 *
 * Movies and episodes rename through `RenamePreviewService`, which is built on
 * their file tables, naming templates and TMDB metadata. Music has none of
 * those: a track's canonical name comes from its MusicBrainz position and
 * title, and the album folder is already generated at import. So this is a
 * separate service with the same contract — file renames only, never folder
 * moves — which keeps the movie path untouched and gives the modal one shape
 * to render.
 *
 * The filename is `NN - Title.ext`, or `D-NN - Title.ext` on multi-disc albums.
 * Re-running it is a no-op because the current name is already the target.
 */

import { db } from '#lib/server/db/index.js';
import { albums, artists, tracks, trackFiles } from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { dirname, extname, join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { createChildLogger } from '#lib/logging/index.js';
import type {
	RenamePreviewItem,
	RenamePreviewResult,
	RenameExecuteResult
} from '#lib/library/naming/types.js';
import { libraryOperationLock } from '../library/library-operation-lock.js';
import { moveFile } from '#lib/server/downloadClients/import/FileTransfer.js';
import { sanitizeMusicSegment } from './paths.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/MediaBrowserNotifier.js';
import { invalidateTrackStream } from './playback/resolver.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

interface TrackForName {
	discNumber: number | null;
	trackNumber: number | null;
	title: string;
}

/** `05 - Crescendolls.flac`, `2-01 - Something.flac` for later discs. */
export function musicTrackFileName(track: TrackForName, extension: string): string {
	const disc = track.discNumber ?? 1;
	const position = String(track.trackNumber ?? 0).padStart(2, '0');
	const prefix = disc > 1 ? `${disc}-${position}` : position;
	return `${prefix} - ${sanitizeMusicSegment(track.title)}${extension}`;
}

function emptyPreview(): RenamePreviewResult {
	return {
		willChange: [],
		alreadyCorrect: [],
		collisions: [],
		errors: [],
		totalFiles: 0,
		totalWillChange: 0,
		totalAlreadyCorrect: 0,
		totalCollisions: 0,
		totalErrors: 0
	};
}

export class MusicRenameService {
	/** Dry run for one album's files. */
	previewAlbum(albumId: string): RenamePreviewResult {
		const result = emptyPreview();
		const album = db.select().from(albums).where(eq(albums.id, albumId)).get();
		if (!album) return result;

		const artist = album.artistId
			? db.select().from(artists).where(eq(artists.id, album.artistId)).get()
			: undefined;
		const mediaTitle = artist ? `${artist.name} - ${album.title}` : album.title;
		const files = db.select().from(trackFiles).where(eq(trackFiles.albumId, albumId)).all();
		const trackRows = files.length
			? db
					.select()
					.from(tracks)
					.where(
						inArray(
							tracks.id,
							files.flatMap((file) => (file.trackId ? [file.trackId] : []))
						)
					)
					.all()
			: [];
		const trackById = new Map(trackRows.map((track) => [track.id, track]));

		for (const file of files) {
			result.totalFiles++;
			const item = this.buildItem(album, mediaTitle, file, trackById.get(file.trackId ?? ''));
			if (item.status === 'error') {
				result.errors.push(item);
				result.totalErrors++;
			} else if (item.status === 'collision') {
				result.collisions.push(item);
				result.totalCollisions++;
			} else if (item.currentRelativePath === item.newRelativePath) {
				item.status = 'already_correct';
				result.alreadyCorrect.push(item);
				result.totalAlreadyCorrect++;
			} else {
				item.status = 'will_change';
				result.willChange.push(item);
				result.totalWillChange++;
			}
		}

		// Two tracks resolving to the same name would overwrite each other.
		const byTarget = new Map<string, RenamePreviewItem[]>();
		for (const item of result.willChange) {
			const list = byTarget.get(item.newFullPath) ?? [];
			list.push(item);
			byTarget.set(item.newFullPath, list);
		}
		for (const [target, items] of byTarget) {
			if (items.length < 2) continue;
			for (const item of items) {
				item.status = 'collision';
				item.collisionsWith = items
					.filter((other) => other.fileId !== item.fileId)
					.map((other) => other.fileId);
				const index = result.willChange.indexOf(item);
				if (index >= 0) result.willChange.splice(index, 1);
				result.totalWillChange--;
				result.collisions.push(item);
				result.totalCollisions++;
			}
			logger.warn({ albumId, target, count: items.length }, '[MusicRename] duplicate target');
		}

		return result;
	}

	/** Move the chosen files and record their new relative paths. */
	async executeRenames(fileIds: string[]): Promise<RenameExecuteResult> {
		return libraryOperationLock.withLock('rename', () => this.executeLocked(fileIds));
	}

	private async executeLocked(fileIds: string[]): Promise<RenameExecuteResult> {
		const touchedAlbums = new Set<string>();
		const touchedFolders = new Set<string>();
		const result: RenameExecuteResult = {
			success: true,
			processed: 0,
			succeeded: 0,
			failed: 0,
			results: [],
			warnings: []
		};
		if (fileIds.length === 0) return result;

		const files = db.select().from(trackFiles).where(inArray(trackFiles.id, fileIds)).all();
		const albumIds = [...new Set(files.map((file) => file.albumId))];
		const previews = new Map<string, RenamePreviewItem>();
		for (const albumId of albumIds) {
			const preview = this.previewAlbum(albumId);
			for (const item of [...preview.willChange, ...preview.errors, ...preview.collisions]) {
				previews.set(item.fileId, item);
			}
		}

		for (const fileId of fileIds) {
			result.processed++;
			const item = previews.get(fileId);
			if (!item) {
				result.failed++;
				result.results.push({
					fileId,
					mediaType: 'music',
					success: false,
					oldPath: '',
					newPath: '',
					error: 'File does not belong to a music album'
				});
				continue;
			}

			if (item.status !== 'will_change') {
				result.failed++;
				result.results.push({
					fileId,
					mediaType: 'music',
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: item.error ?? `Rename not possible (${item.status})`
				});
				continue;
			}

			if (!existsSync(item.currentFullPath)) {
				result.failed++;
				result.results.push({
					fileId,
					mediaType: 'music',
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: 'Source file is missing'
				});
				continue;
			}

			if (existsSync(item.newFullPath)) {
				result.failed++;
				result.results.push({
					fileId,
					mediaType: 'music',
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: 'Target file already exists'
				});
				continue;
			}

			const moved = await moveFile(item.currentFullPath, item.newFullPath);
			if (!moved.success) {
				result.failed++;
				result.results.push({
					fileId,
					mediaType: 'music',
					success: false,
					oldPath: item.currentFullPath,
					newPath: item.newFullPath,
					error: moved.error ?? 'Move failed'
				});
				continue;
			}

			db.update(trackFiles)
				.set({ relativePath: item.newRelativePath })
				.where(eq(trackFiles.id, fileId))
				.run();

			touchedAlbums.add(item.mediaId);
			touchedFolders.add(dirname(item.newFullPath));
			result.succeeded++;
			result.results.push({
				fileId,
				mediaType: 'music',
				success: true,
				oldPath: item.currentFullPath,
				newPath: item.newFullPath
			});
		}

		// The file names changed under the media server and under the cached
		// stream URLs. Tell the first and drop the second.
		for (const albumId of touchedAlbums) {
			const albumTracks = db
				.select({ id: tracks.id })
				.from(tracks)
				.where(eq(tracks.albumId, albumId))
				.all();
			for (const track of albumTracks) invalidateTrackStream(track.id);
		}
		for (const folder of touchedFolders) {
			getMediaBrowserNotifier().queueUpdate(folder, 'Modified', 'rename');
		}

		result.success = result.failed === 0;
		return result;
	}

	private buildItem(
		album: typeof albums.$inferSelect,
		mediaTitle: string,
		file: typeof trackFiles.$inferSelect,
		track: typeof tracks.$inferSelect | undefined
	): RenamePreviewItem {
		const albumPath = album.path ?? '';
		const currentParentPath = join(albumPath, dirname(file.relativePath));
		const currentFullPath = join(albumPath, file.relativePath);
		const base = {
			fileId: file.id,
			mediaType: 'music' as const,
			mediaId: album.id,
			mediaTitle,
			currentParentPath,
			currentRelativePath: file.relativePath,
			currentFullPath,
			newParentPath: currentParentPath,
			newRelativePath: file.relativePath,
			newFullPath: currentFullPath
		};

		if (!albumPath) {
			return { ...base, status: 'error', error: 'Album has no folder on disk' };
		}
		if (!track || track.trackNumber === null) {
			return { ...base, status: 'error', error: 'File is not linked to a track' };
		}

		const extension = extname(file.relativePath) || extname(basename(file.relativePath));
		const newRelativePath =
			dirname(file.relativePath) === '.'
				? musicTrackFileName(
						{ discNumber: track.discNumber, trackNumber: track.trackNumber, title: track.title },
						extension
					)
				: join(
						dirname(file.relativePath),
						musicTrackFileName(
							{ discNumber: track.discNumber, trackNumber: track.trackNumber, title: track.title },
							extension
						)
					);
		const newFullPath = join(albumPath, newRelativePath);
		const existsAtTarget = existsSync(newFullPath) && newFullPath !== currentFullPath;

		return {
			...base,
			newRelativePath,
			newFullPath,
			status: existsAtTarget ? 'collision' : 'will_change'
		};
	}
}

export const musicRenameService = new MusicRenameService();

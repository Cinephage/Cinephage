import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	albums,
	artists,
	libraries,
	libraryRootFolders,
	mediaItems,
	rootFolders,
	tracks
} from '#lib/server/db/schema.js';
import { getOwnerStreamingApiKey } from '#lib/server/auth/index.js';
import { getStreamingBaseUrl } from '#lib/server/streaming/index.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/MediaBrowserNotifier.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { albumFolderName, sanitizeMusicSegment } from './paths.js';

const logger = createChildLogger({ module: 'MusicStrmService', logDomain: 'system' });

export interface AlbumShortcutResult {
	folder: string | null;
	written: number;
	error?: string;
}

interface AlbumRow {
	id: string;
	title: string;
	year: number | null;
	path: string | null;
	hasFile: boolean | null;
	rootFolderId: string | null;
	libraryId: string | null;
	mediaItemId: string;
	artist: string;
}

/**
 * Writing the media-server side of a stream-backed album.
 *
 * Cinephage does not play anything. For an album it cannot own, it writes one
 * `.strm` shortcut per track — the same contract the movie streamer profile
 * already uses — and tells the media servers the folder changed. Jellyfin 12.4
 * indexes these as tracks but only plays them with an audio-shortcut plugin;
 * Emby resolves audio `.strm` natively. Either way the file the server plays is
 * Cinephage's track endpoint, which resolves the source on demand.
 *
 * Owned albums are skipped: their real files already play, and writing
 * shortcuts beside them would duplicate every track in the library.
 */
export class MusicStrmService {
	async writeAlbumShortcuts(albumId: string): Promise<AlbumShortcutResult> {
		const album = db
			.select({
				id: albums.id,
				title: albums.title,
				year: albums.year,
				path: albums.path,
				hasFile: albums.hasFile,
				rootFolderId: albums.rootFolderId,
				libraryId: albums.libraryId,
				mediaItemId: albums.mediaItemId,
				artist: artists.name
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();

		if (!album) return { folder: null, written: 0, error: 'Album not found' };
		if (album.hasFile) return { folder: album.path, written: 0 };

		const rootPath = this.resolveRootPath(album);
		if (!rootPath) {
			return {
				folder: null,
				written: 0,
				error: 'No root folder configured for this album'
			};
		}

		const apiKey = await getOwnerStreamingApiKey();
		if (!apiKey) {
			return { folder: null, written: 0, error: 'No streaming API key available' };
		}

		const folder =
			album.path && album.path.length > 0
				? album.path
				: join(
						rootPath,
						sanitizeMusicSegment(album.artist),
						albumFolderName(album.title, album.year)
					);

		await mkdir(folder, { recursive: true });

		const baseUrl = await getStreamingBaseUrl('');
		if (!baseUrl) {
			throw new ValidationError(
				'Set the streaming base URL before creating stream shortcuts'
			);
		}
		const albumTracks = db
			.select({
				id: tracks.id,
				title: tracks.title,
				trackNumber: tracks.trackNumber,
				discNumber: tracks.discNumber,
				position: tracks.position
			})
			.from(tracks)
			.where(eq(tracks.albumId, albumId))
			.orderBy(tracks.position)
			.all();

		const multiDisc = albumTracks.some((track) => (track.discNumber ?? 1) > 1);
		let written = 0;

		for (const [index, track] of albumTracks.entries()) {
			const number = String(track.trackNumber ?? index + 1).padStart(2, '0');
			const targetFolder =
				multiDisc && (track.discNumber ?? 1) > 1
					? join(folder, `Disc ${track.discNumber}`)
					: folder;

			await mkdir(targetFolder, { recursive: true });

			const fileName = `${number} ${sanitizeMusicSegment(track.title)}.strm`;
			const url = `${baseUrl}/api/streaming/music/track/${track.id}/stream?api_key=${encodeURIComponent(apiKey)}`;
			await writeFile(join(targetFolder, fileName), `${url}\n`, 'utf8');
			written += 1;
		}

		db.update(albums).set({ path: folder }).where(eq(albums.id, albumId)).run();
		if (album.mediaItemId) {
			db.update(mediaItems).set({ path: folder }).where(eq(mediaItems.id, album.mediaItemId)).run();
		}

		getMediaBrowserNotifier().queueUpdate(folder, 'Created', 'import');

		logger.info(
			{ albumId, folder, written, multiDisc },
			'[MusicStrm] Album shortcuts written'
		);

		return { folder, written };
	}

	/** Remove the shortcuts for an album that now has real files. */
	async removeAlbumShortcuts(albumId: string): Promise<number> {
		const album = db
			.select({ path: albums.path })
			.from(albums)
			.where(eq(albums.id, albumId))
			.get();

		if (!album?.path) return 0;
		return this.removeShortcutsInFolder(album.path);
	}

	/** Remove every `.strm` in a folder (including Disc N subfolders). */
	async removeShortcutsInFolder(folder: string): Promise<number> {
		let entries: Dirent[];
		try {
			entries = await readdir(folder, { withFileTypes: true });
		} catch {
			return 0;
		}

		let removed = 0;
		for (const entry of entries) {
			const name = entry.name;
			if (entry.isDirectory() && /^(cd|disc|disk)[\s._-]*\d+$/i.test(name)) {
				removed += await this.removeShortcutsInFolder(join(folder, name));
				continue;
			}
			if (!entry.isFile() || !name.toLowerCase().endsWith('.strm')) continue;
			try {
				await unlink(join(folder, name));
				removed += 1;
			} catch (error) {
				logger.warn(
					{ folder, name, err: error instanceof Error ? error.message : String(error) },
					'[MusicStrm] Could not remove shortcut'
				);
			}
		}

		if (removed > 0) {
			getMediaBrowserNotifier().queueUpdate(folder, 'Modified', 'import');
			logger.info({ folder, removed }, '[MusicStrm] Shortcuts removed');
		}
		return removed;
	}

	private resolveRootPath(album: AlbumRow): string | null {
		if (album.rootFolderId) {
			const row = db
				.select({ path: rootFolders.path })
				.from(rootFolders)
				.where(eq(rootFolders.id, album.rootFolderId))
				.get();
			if (row?.path) return row.path;
		}

		if (album.libraryId) {
			const library = db
				.select({ defaultRootFolderId: libraries.defaultRootFolderId })
				.from(libraries)
				.where(eq(libraries.id, album.libraryId))
				.get();

			if (library?.defaultRootFolderId) {
				const row = db
					.select({ path: rootFolders.path })
					.from(rootFolders)
					.where(eq(rootFolders.id, library.defaultRootFolderId))
					.get();
				if (row?.path) return row.path;
			}

			const linked = db
				.select({ path: rootFolders.path })
				.from(libraryRootFolders)
				.innerJoin(rootFolders, eq(libraryRootFolders.rootFolderId, rootFolders.id))
				.where(eq(libraryRootFolders.libraryId, album.libraryId))
				.limit(1)
				.get();
			if (linked?.path) return linked.path;
		}

		return null;
	}
}

export const musicStrmService = new MusicStrmService();

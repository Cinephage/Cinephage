import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, downloadHistory } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { musicStrmService } from './MusicStrmService.js';
import type { MusicReleaseCandidate } from './MusicSearchService.js';

const logger = createChildLogger({ module: 'MusicStreamGrabService', logDomain: 'system' });

export interface MusicStreamTarget {
	id: string;
	title: string;
	artist: string;
	mediaItemId: string;
	hasFile: boolean | null;
}

export interface MusicStreamGrabResult {
	title: string;
	indexerName: string | null;
	size: number | null;
	tierLabel: string | null;
	/** `.strm` files written for the media servers; 0 for an album with files. */
	shortcuts: number;
	folder: string | null;
}

/**
 * Grabbing an album from the Cinephage Streamer.
 *
 * There is no download client and no queue row: `download_queue` needs a
 * client row to exist, and a stream has none. What the grab leaves behind is
 * the album's source marker, one history row, and the media-server contact
 * sheet: one `.strm` per track pointing at Cinephage's track endpoint.
 *
 * Cinephage does not play anything. The `.strm` files are the deliverable, and
 * the endpoint they name resolves local files or a provider stream on demand.
 * Jellyfin 12.4 indexes audio shortcuts but needs a plugin to play them; Emby
 * resolves audio `.strm` natively.
 */
export class MusicStreamGrabService {
	async grabAlbumStream(
		album: MusicStreamTarget,
		candidate: MusicReleaseCandidate
	): Promise<MusicStreamGrabResult> {
		if (candidate.protocol !== 'streaming') {
			throw new Error(`Not a streaming release: ${candidate.protocol ?? 'unknown'}`);
		}

		// An owned album already plays from its files. A stream marker cannot
		// deliver anything the media server would use, and shortcuts beside the
		// real files would duplicate every track.
		if (album.hasFile) {
			throw new ValidationError(
				'This album already has files; streaming is for albums with no local copy'
			);
		}

		const shortcuts = await musicStrmService.writeAlbumShortcuts(album.id);
		if (shortcuts.error || shortcuts.written === 0) {
			throw new ValidationError(
				`No media-server shortcuts were written: ${shortcuts.error ?? 'album has no tracks'}`
			);
		}

		const now = new Date().toISOString();

		db.update(albums)
			.set({ streamSource: candidate.indexerName ?? 'cinephage-stream' })
			.where(eq(albums.id, album.id))
			.run();

		db.insert(downloadHistory)
			.values({
				title: candidate.title,
				indexerId: candidate.indexerId ?? undefined,
				indexerName: candidate.indexerName ?? undefined,
				protocol: 'streaming',
				status: 'streaming',
				// The release only carries the size sentinel that keeps the
				// protocol validator happy; the real payload size is unknown
				// until playback, so record nothing rather than "100 B".
				size: null,
				grabbedAt: now,
				importedAt: now
			})
			.run();

		logger.info(
			{
				albumId: album.id,
				title: candidate.title,
				indexer: candidate.indexerName,
				artist: album.artist,
				shortcuts: shortcuts.written,
				folder: shortcuts.folder
			},
			'[MusicStreamGrab] album is stream-backed'
		);

		return {
			title: candidate.title,
			indexerName: candidate.indexerName,
			size: null,
			tierLabel: candidate.tierLabel ?? 'Streaming',
			shortcuts: shortcuts.written,
			folder: shortcuts.folder
		};
	}
}

export const musicStreamGrabService = new MusicStreamGrabService();

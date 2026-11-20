import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, downloadHistory } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { MusicReleaseCandidate } from './MusicSearchService.js';

const logger = createChildLogger({ module: 'MusicStreamGrabService', logDomain: 'system' });

export interface MusicStreamTarget {
	id: string;
	title: string;
	artist: string;
	mediaItemId: string;
}

export interface MusicStreamGrabResult {
	title: string;
	indexerName: string | null;
	size: number | null;
	tierLabel: string | null;
}

/**
 * Grabbing an album from the Cinephage Streamer.
 *
 * There is no download client and no queue row: `download_queue` needs a
 * client row to exist, and a stream has none. What the grab leaves behind is
 * the album's source marker plus one history row, which is what the library
 * page and the future player read.
 *
 * No file is written. Audio `.strm` inside a Jellyfin music library is scanned
 * but plays as the URL text — Jellyfin's media source only resolves
 * `ShortcutPath` for video — so music must not reuse the movie `.strm` path.
 */
export class MusicStreamGrabService {
	async grabAlbumStream(
		album: MusicStreamTarget,
		candidate: MusicReleaseCandidate
	): Promise<MusicStreamGrabResult> {
		if (candidate.protocol !== 'streaming') {
			throw new Error(`Not a streaming release: ${candidate.protocol ?? 'unknown'}`);
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
				artist: album.artist
			},
			'[MusicStreamGrab] album is stream-backed'
		);

		return {
			title: candidate.title,
			indexerName: candidate.indexerName,
			size: null,
			tierLabel: candidate.tierLabel ?? 'Streaming'
		};
	}
}

export const musicStreamGrabService = new MusicStreamGrabService();

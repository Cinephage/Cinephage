/**
 * Reading an album ahead of the click.
 *
 * A provider track only becomes instant by not being resolved at playback
 * time: yt-dlp search + resolve is several seconds, and the second track of an
 * album pays it again unless someone already did. So a stream-backed album's
 * unresolved tracks are resolved in the background — after the grab that wrote
 * its shortcuts, and on the first track played from an album grabbed earlier.
 *
 * Deliberately fire-and-forget: nothing here may fail or slow a request. Two at
 * a time keeps yt-dlp from hammering the provider, and the in-memory resolver
 * cache is the authority on what still needs doing, so a warm album costs one
 * query and no provider calls.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, trackFiles, tracks } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { isTrackStreamCached, resolveTrackStream } from './resolver.js';

const logger = createChildLogger({ module: 'MusicStreamWarmer', logDomain: 'streams' });

const MAX_CONCURRENT = 2;

const pending: string[] = [];
const scheduled = new Set<string>();
let active = 0;

function pump(): void {
	while (active < MAX_CONCURRENT && pending.length > 0) {
		const trackId = pending.shift()!;
		active += 1;

		void (async () => {
			try {
				await resolveTrackStream(trackId);
			} catch (error) {
				logger.debug(
					{ trackId, err: error instanceof Error ? error.message : String(error) },
					'[MusicWarmer] Track could not be warmed'
				);
			} finally {
				active -= 1;
				scheduled.delete(trackId);
				pump();
			}
		})();
	}
}

function schedule(trackId: string): void {
	if (scheduled.has(trackId) || isTrackStreamCached(trackId)) return;
	scheduled.add(trackId);
	pending.push(trackId);
}

/**
 * Queues every playable track of a stream-backed album that has no local file
 * and no live resolved stream. Safe to call on every playback: an album that is
 * already warm costs one query and returns.
 */
export function warmAlbum(albumId: string): void {
	try {
		const rows = db
			.select({ id: tracks.id })
			.from(tracks)
			.innerJoin(albums, eq(tracks.albumId, albums.id))
			.leftJoin(trackFiles, eq(trackFiles.trackId, tracks.id))
			.where(
				and(eq(tracks.albumId, albumId), isNotNull(albums.streamSource), isNull(trackFiles.id))
			)
			.all();

		for (const row of rows) schedule(row.id);
		pump();
	} catch (error) {
		logger.warn(
			{ albumId, err: error instanceof Error ? error.message : String(error) },
			'[MusicWarmer] Could not queue the album'
		);
	}
}

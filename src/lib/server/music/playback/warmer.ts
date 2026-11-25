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
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, trackFiles, trackStreamCache, tracks } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { isTrackStreamCached, resolveTrackStream } from './resolver.js';

const logger = createChildLogger({ module: 'MusicStreamWarmer', logDomain: 'streams' });

const MAX_CONCURRENT = 4;

/**
 * Two lanes, not one queue.
 *
 * `urgent` is the album being listened to right now; `pending` is everything
 * that was queued by a grab. A bulk "search missing" enqueues a thousand
 * tracks, and a listener's next skip must not wait behind them.
 */
const urgent: string[] = [];
const pending: string[] = [];
const scheduled = new Set<string>();
let active = 0;

function nextTrackId(): string | undefined {
	return urgent.shift() ?? pending.shift();
}

function pump(): void {
	while (active < MAX_CONCURRENT) {
		const trackId = nextTrackId();
		if (!trackId) return;
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

function schedule(trackId: string, urgentFlag: boolean): void {
	if (scheduled.has(trackId) || isTrackStreamCached(trackId)) return;
	scheduled.add(trackId);
	if (urgentFlag) urgent.push(trackId);
	else pending.push(trackId);
}

/**
 * Queues every playable track of a stream-backed album that has no local file
 * and no live resolved stream. Safe to call on every playback: an album that is
 * already warm costs one query and returns.
 */
export function warmAlbum(
	albumId: string,
	options: { afterTrackId?: string | null; urgent?: boolean } = {}
): void {
	try {
		const rows = db
			.select({ id: tracks.id, position: tracks.position })
			.from(tracks)
			.innerJoin(albums, eq(tracks.albumId, albums.id))
			.leftJoin(trackFiles, eq(trackFiles.trackId, tracks.id))
			.where(
				and(eq(tracks.albumId, albumId), isNotNull(albums.streamSource), isNull(trackFiles.id))
			)
			.orderBy(tracks.position)
			.all();

		// What is playing defines what comes next: the tracks after it first, then
		// the ones before. Warming in shelf order made the very first skip pay for
		// a track the listener had already passed.
		const playedAt = options.afterTrackId
			? rows.findIndex((row) => row.id === options.afterTrackId)
			: -1;
		const ordered =
			playedAt >= 0 ? [...rows.slice(playedAt + 1), ...rows.slice(0, playedAt)] : rows;

		for (const row of ordered) schedule(row.id, options.urgent ?? false);
		pump();
	} catch (error) {
		logger.warn(
			{ albumId, err: error instanceof Error ? error.message : String(error) },
			'[MusicWarmer] Could not queue the album'
		);
	}
}

/**
 * Re-queue the album that was playing before the process restarted.
 *
 * The resolved URLs survive a restart (they are rows, not memory), but the
 * warm queue does not — so a deploy left the album mid-listen cold again.
 * One album, no library-wide sweep: warming a thousand tracks at boot is how a
 * box earns a provider throttle.
 */
export function rearmRecentlyPlayed(): void {
	try {
		const row = db
			.select({ albumId: tracks.albumId })
			.from(trackStreamCache)
			.innerJoin(tracks, eq(tracks.id, trackStreamCache.trackId))
			.orderBy(desc(trackStreamCache.expiresAt))
			.limit(1)
			.get();
		if (!row?.albumId) return;
		warmAlbum(row.albumId, { urgent: true });
		logger.info({ albumId: row.albumId }, '[MusicWarmer] re-armed the album last played');
	} catch (error) {
		logger.debug(
			{ err: error instanceof Error ? error.message : String(error) },
			'[MusicWarmer] Could not re-arm the last album'
		);
	}
}

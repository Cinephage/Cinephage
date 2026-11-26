/**
 * Matching streamed music to an upload, before anyone plays it.
 *
 * A stream-backed track starts slowly for one of two reasons: nobody has picked
 * the upload it plays from yet, or the provider URL has expired. Picking costs
 * a search (~3.5 s) *and* a resolve (~2.5 s); a resolved URL lives only about
 * six hours, so refreshing it on a schedule would be wasted work that expires
 * before it is used. The match is the part that lasts, and the part this pass
 * does: every streamed track ends up with a remembered upload, so the first
 * play of any album costs one resolve instead of a search plus a resolve, and
 * the pick is stable rather than whatever the search ranked first that day.
 *
 * No audio is stored. Streaming stays streaming: the pass only writes the chosen
 * upload id and the (short-lived) provider URL the resolver already keeps, both
 * of which are rows in the existing tables.
 *
 * Deliberately free once it is done: a matched track causes no provider call at
 * all, so a second run over a matched library is a handful of SQLite reads.
 */
import { desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, tracks } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { resolveTrackStream } from './playback/resolver.js';
import { listStreamAlbumTracks } from './playback/warmer.js';

const logger = createChildLogger({ module: 'MusicStreamMatch', logDomain: 'streams' });

export interface MatchAlbumItem {
	albumId: string;
	title: string;
	artistName: string;
	tracks: number;
	matched: number;
	alreadyMatched: number;
	unresolved: number;
}

export interface MatchSummary {
	/** Stream-backed albums considered. */
	albums: number;
	/** Albums that had at least one track to match. */
	albumsTouched: number;
	/** Tracks with no local file, across the albums considered. */
	tracks: number;
	/** Tracks matched to an upload by this run (a provider call each). */
	matched: number;
	/** Tracks that already had a remembered upload — no provider call. */
	alreadyMatched: number;
	/** Tracks the provider could not match. */
	unresolved: number;
	stoppedReason: 'complete' | 'album-limit';
}

export interface MatchOptions {
	/** Hard cap for one run; 0 or omitted means every stream-backed album. */
	limitAlbums?: number;
}

export async function matchStreamedMusic(
	ctx: TaskExecutionContext | null,
	options: MatchOptions = {}
): Promise<{ summary: MatchSummary; items: MatchAlbumItem[] }> {
	const rows = db
		.select({ albumId: albums.id, title: albums.title, artistName: artists.name })
		.from(albums)
		.innerJoin(artists, eq(artists.id, albums.artistId))
		.where(isNotNull(albums.streamSource))
		// Newest additions first: if a run is cut short, the album added
		// yesterday is more likely to be played than a back-catalogue one.
		.orderBy(desc(albums.added))
		.all();

	const limit = options.limitAlbums && options.limitAlbums > 0 ? options.limitAlbums : rows.length;

	const summary: MatchSummary = {
		albums: 0,
		albumsTouched: 0,
		tracks: 0,
		matched: 0,
		alreadyMatched: 0,
		unresolved: 0,
		stoppedReason: 'complete'
	};
	const items: MatchAlbumItem[] = [];

	for (const album of rows) {
		if (summary.albums >= limit) {
			summary.stoppedReason = 'album-limit';
			break;
		}
		summary.albums += 1;

		const albumTracks = listStreamAlbumTracks(album.albumId);
		if (albumTracks.length === 0) continue;

		const item: MatchAlbumItem = {
			albumId: album.albumId,
			title: album.title,
			artistName: album.artistName,
			tracks: albumTracks.length,
			matched: 0,
			alreadyMatched: 0,
			unresolved: 0
		};

		for (const track of albumTracks) {
			ctx?.checkCancelled();
			summary.tracks += 1;

			const remembered = db
				.select({ videoId: tracks.streamVideoId })
				.from(tracks)
				.where(eq(tracks.id, track.id))
				.get();
			if (remembered?.videoId) {
				summary.alreadyMatched += 1;
				item.alreadyMatched += 1;
				continue;
			}

			// One resolve walks the same path playback would: search, pick, remember
			// the upload, keep the URL. The next play finds all of it already there.
			const outcome = await resolveTrackStream(track.id);
			if (outcome.status === 'ok' && outcome.stream.source === 'youtube') {
				summary.matched += 1;
				item.matched += 1;
			} else {
				summary.unresolved += 1;
				item.unresolved += 1;
			}
		}

		if (item.matched > 0 || item.unresolved > 0) {
			summary.albumsTouched += 1;
			items.push(item);
			logger.info({ ...item }, '[MusicStreamMatch] Album matched');
		}
	}

	logger.info({ ...summary }, '[MusicStreamMatch] Run finished');
	return { summary, items };
}

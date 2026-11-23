/**
 * Turning playlist entries into albums.
 *
 * MusicBrainz is the identity source for the whole music domain, so a playlist
 * import is a resolution problem, not a download problem: every entry has to
 * land on a release group before anything can be added.
 *
 * Two routes, cheapest first:
 *   - the source knows the album (Deezer) -> one release-group search per
 *     *album*, and every track of that album rides on the same answer;
 *   - the source only knows a song (YouTube, Spotify embed) -> one recording
 *     search per track, whose hit carries the release group it appeared on.
 *
 * Both routes are validated the same way: the title and the artist have to
 * actually match. MusicBrainz scores near-identical names highly ("Discovery
 * Remixed" scores 94 against "Discovery"), so the score alone is not enough to
 * add an album to someone's library.
 */
import { inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums } from '#lib/server/db/schema.js';
import { normalizeForMatch } from '../track-matching.js';
import { MusicBrainzError, musicBrainz } from '../musicbrainz.js';
import type { MusicReleaseGroup } from '../types.js';
import { createChildLogger } from '#lib/logging/index.js';
import type {
	AlbumCandidate,
	MatchBasis,
	MatchConfidence,
	PlaylistTrack,
	ResolveResult,
	UnmatchedTrack
} from './types.js';

const logger = createChildLogger({ module: 'MusicPlaylistResolve', logDomain: 'system' });

/** MusicBrainz sheds load with 503s; a playlist is dozens of requests long. */
const LOOKUP_ATTEMPTS = 3;
const LOOKUP_BACKOFF_MS = 4_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One lookup, retried across transient throttling.
 *
 * The shared client already retries a 503 three times; that covers one blip,
 * not a minute of load shedding — which is what a 50-song playlist walks into.
 * Returning null after the last attempt lets the caller mark the one row that
 * failed and keep going, instead of discarding every album resolved so far.
 */
async function lookup<T>(call: () => Promise<T>): Promise<T | null> {
	for (let attempt = 1; attempt <= LOOKUP_ATTEMPTS; attempt++) {
		try {
			return await call();
		} catch (err) {
			const retryable = err instanceof MusicBrainzError ? err.retryable : true;
			if (!retryable || attempt === LOOKUP_ATTEMPTS) {
				logger.warn(
					{ err: err instanceof Error ? err.message : String(err), attempt },
					'[MusicPlaylistResolve] MusicBrainz lookup gave up'
				);
				return null;
			}
			await sleep(LOOKUP_BACKOFF_MS * attempt);
		}
	}
	return null;
}

/** Search at most this many hits; MusicBrainz's own ordering is good, we only verify. */
const SEARCH_LIMIT = 10;

/**
 * Wording that decorates an edition without changing the work. Stripped before
 * comparing, so "Hey Jude (Remastered 2015)" still matches "Hey Jude" while
 * "Discovery Remixed" does not match "Discovery".
 */
const DECORATIONS = /\b(remaster(ed)?|deluxe|expanded|edition|explicit|anniversary|bonus|version)\b/g;
/** "Remastered 2015" and "2015 Remaster": the year belongs to the decoration, not the title. */
const DECORATED_YEAR = /\b(?:(?:19|20)\d{2}\s+)?(?:remaster(?:ed)?|version)\s+(?:(?:19|20)\d{2})?\b/g;

function core(text: string): string {
	return normalizeForMatch(
		// A bracketed tail names the edition or the upload, never the work:
		// "What a Wonderful World (Remastered)" is the same song. Dropping the
		// bracket is also what makes single-version titles resolve at all —
		// "California Dreamin' (Single Version)" left "single" behind.
		text.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
	)
		.replace(DECORATED_YEAR, ' ')
		.replace(DECORATIONS, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Same work, not merely a similar name. Equality after decoration stripping —
 * "Hey Jude (Remastered 2015)" equals "Hey Jude", but "Discovery Remixed" is a
 * different release group from "Discovery" and must not be silently added in
 * its place.
 */
export function titlesMatch(query: string, candidate: string): boolean {
	const left = core(query);
	const right = core(candidate);
	if (!left || !right) return false;
	return left === right;
}

/**
 * A credit like "Peso Pluma, Anitta" is two artists; MusicBrainz matches the
 * whole credit string. Any listed artist matching is enough, because the
 * playlist named them as performers.
 */
function artistMatches(queryArtists: string[], candidate: string): boolean {
	const candidateCore = core(candidate);
	if (!candidateCore) return false;
	return queryArtists.some((artist) => {
		const query = core(artist);
		if (!query) return false;
		return candidateCore === query || candidateCore.includes(query) || query.includes(candidateCore);
	});
}

interface AlbumGroup {
	artist: string;
	album: string;
	tracks: PlaylistTrack[];
}

function groupByAlbum(tracks: PlaylistTrack[]): { groups: AlbumGroup[]; loose: PlaylistTrack[] } {
	const groups = new Map<string, AlbumGroup>();
	const loose: PlaylistTrack[] = [];
	for (const track of tracks) {
		const artist = track.artists[0]?.trim();
		const album = track.album?.trim();
		if (!artist || !album) {
			loose.push(track);
			continue;
		}
		const key = `${core(artist)}|${core(album)}`;
		const existing = groups.get(key);
		if (existing) existing.tracks.push(track);
		else groups.set(key, { artist, album, tracks: [track] });
	}
	return { groups: [...groups.values()], loose };
}

/** Best album hit for one artist+album pair, verified rather than trusted. */
function pickReleaseGroup(
	hits: MusicReleaseGroup[],
	artist: string,
	album: string
): MusicReleaseGroup | null {
	for (const hit of hits) {
		if (!titlesMatch(album, hit.title)) continue;
		if (!artistMatches([artist], hit.artist.name)) continue;
		return hit;
	}
	return null;
}

function addCandidate(
	candidates: Map<string, AlbumCandidate>,
	group: MusicReleaseGroup,
	track: PlaylistTrack,
	basis: MatchBasis,
	confidence: MatchConfidence
): void {
	const existing = candidates.get(group.mbid);
	const entry: { title: string; artist: string } = {
		title: track.title,
		artist: track.artists[0] ?? group.artist.name
	};
	if (!existing) {
		candidates.set(group.mbid, {
			id: group.mbid,
			releaseGroupMbid: group.mbid,
			title: group.title,
			artistName: group.artist.name,
			artistMbid: group.artist.mbid,
			year: group.year ?? null,
			primaryType: group.primaryType ?? null,
			matchedBy: basis,
			confidence,
			tracks: [entry],
			inLibrary: false,
			albumId: null
		});
		return;
	}
	// One album reached from an album-level group is a stronger statement than
	// the same album reached track by track; keep the better basis.
	if (basis === 'album') {
		existing.matchedBy = 'album';
		existing.confidence = confidence;
	}
	existing.tracks.push(entry);
}

function markInLibrary(candidates: AlbumCandidate[]): void {
	if (candidates.length === 0) return;
	const mbids = candidates.map((candidate) => candidate.releaseGroupMbid);
	// SQLite's parameter cap: chunk well under it, and the playlist cap is 500.
	const found = new Map<string, string>();
	for (let index = 0; index < mbids.length; index += 400) {
		const chunk = mbids.slice(index, index + 400);
		const rows = db
			.select({ id: albums.id, mbid: albums.mbid })
			.from(albums)
			.where(inArray(albums.mbid, chunk))
			.all();
		for (const row of rows) if (row.mbid) found.set(row.mbid, row.id);
	}
	for (const candidate of candidates) {
		const albumId = found.get(candidate.releaseGroupMbid);
		if (albumId) {
			candidate.inLibrary = true;
			candidate.albumId = albumId;
		}
	}
}

export interface ResolveOptions {
	/** Called after each MusicBrainz round trip so a job can report progress. */
	onProgress?: (progress: { done: number; total: number; phase: string }) => void;
}

export async function resolvePlaylistTracks(
	tracks: PlaylistTrack[],
	options: ResolveOptions = {}
): Promise<ResolveResult> {
	const { groups, loose } = groupByAlbum(tracks);
	let total = groups.length + loose.length;
	let done = 0;
	const candidates = new Map<string, AlbumCandidate>();
	const unmatched: UnmatchedTrack[] = [];
	let resolvedTracks = 0;

	const report = (phase: string) => options.onProgress?.({ done, total, phase });
	report('Resolving albums');

	for (const group of groups) {
		// Query with the cleaned title: MusicBrainz matches the literal string,
		// so "1 (Remastered 2015)" finds nothing while "1" finds the album.
		const hits = await lookup(() =>
			musicBrainz.searchReleaseGroups({
				artist: group.artist,
				album: core(group.album),
				limit: SEARCH_LIMIT
			})
		);
		if (!hits) {
			for (const track of group.tracks) {
				unmatched.push({ title: track.title, artist: group.artist, reason: 'lookup-failed' });
			}
			done += 1;
			report('Resolving albums');
			continue;
		}
		const picked = pickReleaseGroup(hits, group.artist, group.album);
		if (picked) {
			for (const track of group.tracks) {
				addCandidate(candidates, picked, track, 'album', 'high');
				resolvedTracks += 1;
			}
		} else {
			// The album name did not resolve — the songs still might, one at a
			// time. Losing them here would drop exactly what the user pasted.
			loose.push(...group.tracks);
			// Progress counts every MusicBrainz round trip, and these tracks
			// just became one each; without this the bar can pass its own total.
			total += group.tracks.length;
		}
		done += 1;
		report('Resolving albums');
	}

	for (const track of loose) {
		const artist = track.artists[0]?.trim();
		if (!artist) {
			unmatched.push({ title: track.title, artist: null, reason: 'no-artist' });
			done += 1;
			report('Resolving songs');
			continue;
		}

		const hits = await lookup(() =>
			musicBrainz.searchRecordings({
				artist,
				track: core(track.title),
				limit: SEARCH_LIMIT
			})
		);
		if (!hits) {
			unmatched.push({ title: track.title, artist, reason: 'lookup-failed' });
			done += 1;
			report('Resolving songs');
			continue;
		}
		// Several recordings match the title; prefer one whose release is the
		// artist's own rather than a compilation they appear on.
		const matching = hits.filter(
			(candidate) =>
				candidate.releaseGroup &&
				titlesMatch(track.title, candidate.title) &&
				artistMatches(track.artists, candidate.artistCredit)
		);
		const hit = matching.find((candidate) => candidate.releaseOwned) ?? matching[0] ?? null;

		if (hit?.releaseGroup) {
			// A recording hit carries the group but not the artist's mbid; the
			// group's own artist is what the album row needs.
			const group = await lookup(() => musicBrainz.getReleaseGroup(hit.releaseGroup!.mbid));
			if (!group) {
				unmatched.push({ title: track.title, artist, reason: 'lookup-failed' });
			} else if (artistMatches(track.artists, group.artist.name)) {
				addCandidate(candidates, group, track, 'track', 'low');
				resolvedTracks += 1;
			} else {
				// MusicBrainz picked a Various Artists compilation because it was
				// the first official release of the recording. That is not what
				// the user pasted. The song's own single or album is usually
				// named after it, so try that before giving up — adding a random
				// karaoke compilation to someone's library is worse than adding
				// nothing and saying so.
				const sameNamed = await lookup(() =>
					musicBrainz.searchReleaseGroups({ artist, album: core(track.title), limit: SEARCH_LIMIT })
				);
				const own = sameNamed?.find(
					(candidate) =>
						titlesMatch(track.title, candidate.title) &&
						artistMatches(track.artists, candidate.artist.name)
				);
				if (own) {
					addCandidate(candidates, own, track, 'track', 'low');
					resolvedTracks += 1;
				} else {
					unmatched.push({ title: track.title, artist, reason: 'no-match' });
				}
			}
		} else {
			unmatched.push({ title: track.title, artist, reason: 'no-match' });
		}
		done += 1;
		report('Resolving songs');
	}

	const list = [...candidates.values()].sort((a, b) => {
		// Albums with more of the user's songs first; that is what they will
		// recognise in the preview.
		if (b.tracks.length !== a.tracks.length) return b.tracks.length - a.tracks.length;
		return a.title.localeCompare(b.title);
	});
	markInLibrary(list);

	return { candidates: list, unmatched, resolvedTracks };
}

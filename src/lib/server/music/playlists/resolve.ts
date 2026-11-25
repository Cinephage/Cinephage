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
import { artistMatches, coreTitle, normalizeForMatch } from '../track-matching.js';
import { COMPILATION_SECONDARY, musicBrainz } from '../musicbrainz.js';
import {
	getAlbumMatch,
	getArtistAlbums,
	getArtistMbid,
	getSongMatch,
	setAlbumMatch,
	setArtistAlbums,
	setArtistMbid,
	setSongMatch
} from './cache.js';
import type { MusicRecordingHit, MusicReleaseGroup, MusicReleaseGroupRef } from '../types.js';
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

/** Search at most this many hits; MusicBrainz's own ordering is good, we only verify. */
const SEARCH_LIMIT = 10;

/** Extra passes over songs whose lookup was refused, not answered. */
const RETRY_PASSES = 2;

/**
 * Same work, not merely a similar name. Equality after decoration stripping —
 * "Hey Jude (Remastered 2015)" equals "Hey Jude", but "Discovery Remixed" is a
 * different release group from "Discovery" and must not be silently added in
 * its place.
 */
export function titlesMatch(query: string, candidate: string): boolean {
	const left = coreTitle(query);
	const right = coreTitle(candidate);
	if (!left || !right) return false;
	return left === right;
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
		const key = `${coreTitle(artist)}|${coreTitle(album)}`;
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
			source: 'musicbrainz',
			sourceId: null,
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

/**
 * An album the catalog knows and MusicBrainz does not.
 *
 * The library is keyed on the MusicBrainz release group, so an album with no
 * release group used to be unstorable — and a playlist of underground or
 * brand-new music came back "could not be matched" even though the catalog
 * held every track, its album, its cover and its date. Refusing the songs
 * because one upstream has not heard of them is the worst of the options: the
 * row is marked as catalog-sourced, keeps its id, and can be re-matched to a
 * release group later.
 */
function addCatalogCandidate(
	candidates: Map<string, AlbumCandidate>,
	album: { sourceId: string; title: string; artist: string; year: number | null },
	tracks: PlaylistTrack[]
): void {
	const key = `deezer:${album.sourceId}`;
	const entries = tracks.map((track) => ({ title: track.title, artist: album.artist }));
	const existing = candidates.get(key);
	if (existing) {
		existing.tracks.push(...entries);
		return;
	}
	candidates.set(key, {
		id: key,
		releaseGroupMbid: key,
		source: 'deezer',
		sourceId: album.sourceId,
		title: album.title,
		artistName: album.artist,
		// No MusicBrainz artist either; artist-scope expansion cannot use this.
		artistMbid: '',
		year: album.year,
		primaryType: null,
		matchedBy: 'album',
		confidence: 'high',
		tracks: entries,
		inLibrary: false,
		albumId: null
	});
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
	/** A cancelled job stops before the next item, not after the whole list. */
	isCancelled?: () => boolean;
}

function typeRank(group: MusicReleaseGroup): number {
	const secondary = new Set(group.secondaryTypes ?? []);
	const plain = !COMPILATION_SECONDARY.some((type) => secondary.has(type));
	if (group.primaryType === 'Album') return plain ? 4 : 1;
	if (group.primaryType === 'EP') return plain ? 3 : 1;
	if (group.primaryType === 'Single') return 2;
	return 0;
}

/**
 * The group a song belongs to: the best type the artist owns, earliest first.
 *
 * A search release can arrive without an artist credit. Such a group is not a
 * candidate — the whole point of the filter is that the album belongs to this
 * act, and an unknown credit cannot say that.
 */
function pickGroup(groups: MusicReleaseGroupRef[], track: PlaylistTrack): MusicReleaseGroup | null {
	const owned = groups.filter((group): group is MusicReleaseGroup => group.artist !== null);
	return (
		owned
			.filter((group) => artistMatches(track.artists, group.artist.name))
			.sort(
				(a, b) =>
					typeRank(b) - typeRank(a) ||
					(a.firstReleaseDate ?? '9999').localeCompare(b.firstReleaseDate ?? '9999')
			)[0] ?? null
	);
}

function yearOfDate(date: string | null | undefined): number | null {
	const match = /^(\d{4})/.exec(date ?? '');
	return match ? Number(match[1]) : null;
}

/**
 * The album a recording hit belongs to, without asking MusicBrainz again: the
 * search already returned the release group's id, title, type and first date,
 * plus the release's artist credit, which is the group's artist. That is one
 * request per song instead of two.
 */
function groupFromHit(hit: MusicRecordingHit): MusicReleaseGroup | null {
	const group = hit.releaseGroup;
	if (!group?.artist) return null;
	return {
		mbid: group.mbid,
		title: group.title,
		primaryType: group.primaryType ?? null,
		secondaryTypes: group.secondaryTypes ?? [],
		firstReleaseDate: group.firstReleaseDate ?? null,
		year: yearOfDate(group.firstReleaseDate),
		artist: group.artist
	};
}

/**
 * One MusicBrainz call, no retry loop of our own.
 *
 * The client already retries a throttled request three times with a long,
 * growing wait. Retrying again up here multiplied the request rate exactly when
 * MusicBrainz was shedding load — which is how an IP gets blocked — so a failed
 * lookup is now reported and left alone.
 */
type Attempt<T> = { ok: true; value: T } | { ok: false };

async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
	try {
		return { ok: true, value: await call() };
	} catch (err) {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			'[MusicPlaylistResolve] MusicBrainz lookup failed'
		);
		return { ok: false };
	}
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
	/** Album groups whose name did not resolve; their songs go through phase 2. */
	const leftover: PlaylistTrack[] = [];

	const report = (phase: string) => options.onProgress?.({ done, total, phase });

	// One artist lookup per name, cached for the next playlist: searching
	// recordings by id is what keeps same-titled tracks by other people out.
	const artistIds = new Map<string, string | null>();
	const artistMbidFor = async (name: string): Promise<string | null> => {
		if (artistIds.has(name)) return artistIds.get(name) ?? null;
		const cached = getArtistMbid(name);
		let mbid = cached ? cached.value : null;
		if (!cached) {
			const resolved = await attempt(() => musicBrainz.resolveArtistMbid(name));
			if (resolved.ok) {
				mbid = resolved.value;
				// Only a successful answer is a cacheable fact; a 503 is not
				// "no such artist" for the next seven days.
				setArtistMbid(name, mbid);
			}
		}
		artistIds.set(name, mbid);
		return mbid;
	};

	// The artist's own studio albums, indexed by track title. A song title is
	// tiny and shared — searching recordings by title finds other people's
	// tracks before the artist's own — so the discography is the search space.
	const albumIndexes = new Map<string, Map<string, MusicReleaseGroup[]>>();
	const albumIndexFor = async (mbid: string): Promise<Map<string, MusicReleaseGroup[]>> => {
		const ready = albumIndexes.get(mbid);
		if (ready) return ready;
		const stored = getArtistAlbums(mbid);
		const fetched = stored?.value
			? { ok: true as const, value: stored.value }
			: await attempt(() => musicBrainz.getArtistAlbumTrackIndex(mbid));
		const rows = fetched.ok ? fetched.value : null;
		if (!stored && fetched.ok) setArtistAlbums(mbid, fetched.value);
		const index = new Map<string, MusicReleaseGroup[]>();
		for (const row of rows ?? []) {
			const key = normalizeForMatch(coreTitle(row.title));
			index.set(key, [...(index.get(key) ?? []), ...row.groups]);
		}
		albumIndexes.set(mbid, index);
		return index;
	};

	report('Resolving albums');
	for (const group of groups) {
		if (options.isCancelled?.()) break;
		// The cached answer is the same one a search would produce, so a re-import
		// of an unchanged playlist costs no request at all.
		const query = coreTitle(group.album);
		const cached = getAlbumMatch(group.artist, query);
		let picked: MusicReleaseGroup | null;
		if (cached) {
			picked = cached.value;
		} else {
			const hitResult = await attempt(() =>
				musicBrainz.searchReleaseGroups({
					artist: group.artist,
					album: query,
					limit: SEARCH_LIMIT
				})
			);
			if (!hitResult.ok) {
				for (const track of group.tracks) {
					unmatched.push({ title: track.title, artist: group.artist, reason: 'lookup-failed' });
				}
				done += 1;
				report('Resolving albums');
				continue;
			}
			picked = pickReleaseGroup(hitResult.value, group.artist, group.album);
			setAlbumMatch(group.artist, query, picked);
		}
		if (picked) {
			for (const track of group.tracks) {
				addCandidate(candidates, picked, track, 'album', 'high');
				resolvedTracks += 1;
			}
		} else if (group.tracks[0]?.albumSourceId) {
			// MusicBrainz has no release group for this album, but the catalog
			// named one — every track on the list came from it. Store it as a
			// catalog album rather than reporting songs the user can hear as
			// unmatchable.
			addCatalogCandidate(
				candidates,
				{
					sourceId: group.tracks[0].albumSourceId,
					title: group.album,
					artist: group.artist,
					year: group.tracks[0].year ?? null
				},
				group.tracks
			);
			resolvedTracks += group.tracks.length;
		} else {
			// The album name resolved to nothing — the songs still might, one at a
			// time. Losing them here would drop exactly what the user pasted.
			leftover.push(...group.tracks);
			total += group.tracks.length;
		}
		done += 1;
		report('Resolving albums');
	}

	report('Resolving songs');
	for (const track of [...loose, ...leftover]) {
		if (options.isCancelled?.()) break;
		const artist = track.artists[0]?.trim();
		if (!artist) {
			unmatched.push({ title: track.title, artist: null, reason: 'no-artist' });
			done += 1;
			report('Resolving songs');
			continue;
		}

		const query = coreTitle(track.title);
		const cached = getSongMatch(artist, query);
		if (cached) {
			if (cached.value) {
				addCandidate(candidates, cached.value, track, 'track', 'low');
				resolvedTracks += 1;
			} else {
				unmatched.push({ title: track.title, artist, reason: 'no-match' });
			}
			done += 1;
			report('Resolving songs');
			continue;
		}

		const artistMbid = await artistMbidFor(artist);
		if (artistMbid) {
			const index = await albumIndexFor(artistMbid);
			const fromAlbum = pickGroup(index.get(normalizeForMatch(query)) ?? [], track);
			if (fromAlbum) {
				addCandidate(candidates, fromAlbum, track, 'track', 'low');
				setSongMatch(artist, query, fromAlbum);
				resolvedTracks += 1;
				done += 1;
				report('Resolving songs');
				continue;
			}
		}

		const recordingResult = await attempt(() =>
			musicBrainz.searchRecordings({
				artist,
				artistMbid: artistMbid ?? undefined,
				track: query,
				limit: SEARCH_LIMIT
			})
		);
		if (!recordingResult.ok) {
			unmatched.push({ title: track.title, artist, reason: 'lookup-failed' });
			done += 1;
			report('Resolving songs');
			continue;
		}

		// The group the search reports is the answer when it is a plain album; now
		// that the search is keyed by artist id it usually is. When it is not — a
		// single, a live set, a hits package — ask what else the recording is on
		// and take the album from there.
		const anchor = recordingResult.value.find(
			(candidate) =>
				titlesMatch(track.title, candidate.title) &&
				artistMatches(track.artists, candidate.artistCredit)
		);
		// The search already returned every release group this recording is on,
		// ranked. Choosing the album from that list is the decision a follow-up
		// browse used to make — one request cheaper, per song.
		const reported = anchor ? groupFromHit(anchor) : null;
		let group =
			(anchor ? pickGroup(anchor.releaseGroups, track) : null) ??
			(reported && artistMatches(track.artists, reported.artist.name) ? reported : null);
		// The search can name a recording and list no releases for it. That is the
		// one case the response cannot answer, so it is the only case still worth
		// a browse: every other album was already in the response, ranked.
		if (!group && anchor && anchor.releaseGroups.length === 0) {
			const appearances = await attempt(() => musicBrainz.getRecordingReleaseGroups(anchor.mbid));
			if (appearances.ok) group = pickGroup(appearances.value, track);
		}

		if (group) {
			addCandidate(candidates, group, track, 'track', 'low');
			setSongMatch(artist, query, group);
			resolvedTracks += 1;
			done += 1;
			report('Resolving songs');
			continue;
		}

		// MusicBrainz picked a Various Artists compilation because it was the
		// first official release of the recording. That is not what the user
		// pasted. The song's own single or album is usually named after it, so
		// try that before giving up — adding a random karaoke compilation to
		// someone's library is worse than adding nothing and saying so.
		const sameNamed = await attempt(() =>
			musicBrainz.searchReleaseGroups({
				artist,
				album: coreTitle(track.title),
				limit: SEARCH_LIMIT
			})
		);
		if (!sameNamed.ok) {
			// A failed last lookup is not "MusicBrainz has no such song".
			unmatched.push({ title: track.title, artist, reason: 'lookup-failed' });
			done += 1;
			report('Resolving songs');
			continue;
		}
		const own = sameNamed.value.find(
			(candidate) =>
				titlesMatch(track.title, candidate.title) &&
				artistMatches(track.artists, candidate.artist.name)
		);
		if (own) {
			addCandidate(candidates, own, track, 'track', 'low');
			setSongMatch(artist, query, own);
			resolvedTracks += 1;
		} else {
			setSongMatch(artist, query, null);
			unmatched.push({ title: track.title, artist, reason: 'no-match' });
		}
		done += 1;
		report('Resolving songs');
	}

	/**
	 * A 503 is not "no such song".
	 *
	 * Under load MusicBrainz refuses about half of all calls, and one song can
	 * need three of them, so a single pass loses most of a playlist: a 50-song
	 * import measured 12 albums and 38 "unmatched", which was the catalog being
	 * unreachable, not the songs being unknowable. Everything already answered is
	 * cached, so extra passes cost one call per failed song — the gate still
	 * spaces them — and nothing resolved is ever asked for twice.
	 */
	const retryUnreachable = async (): Promise<void> => {
		for (let pass = 1; pass <= RETRY_PASSES; pass += 1) {
			const pending = unmatched.filter((entry) => entry.reason === 'lookup-failed');
			if (pending.length === 0) return;
			logger.info(
				{ pass, songs: pending.length },
				'[MusicPlaylistResolve] retrying songs MusicBrainz could not answer'
			);
			report(`Retrying ${pending.length} songs`);
			for (const entry of [...pending]) {
				if (options.isCancelled?.()) return;
				const artist = entry.artist;
				if (!artist) continue;
				const query = coreTitle(entry.title);
				const mbid = await artistMbidFor(artist);
				const search = await attempt(() =>
					musicBrainz.searchRecordings({
						artist,
						artistMbid: mbid ?? undefined,
						track: query,
						limit: SEARCH_LIMIT
					})
				);
				if (!search.ok) continue;
				const retried: PlaylistTrack = {
					title: entry.title,
					artists: [artist],
					album: null,
					year: null,
					durationMs: null,
					isrc: null
				};
				const anchor = search.value.find(
					(hit) =>
						titlesMatch(entry.title, hit.title) && artistMatches(retried.artists, hit.artistCredit)
				);
				let group: MusicReleaseGroup | null = null;
				if (anchor) {
					const reported = groupFromHit(anchor);
					group =
						pickGroup(anchor.releaseGroups, retried) ??
						(reported && artistMatches(retried.artists, reported.artist.name) ? reported : null);
					if (!group && anchor.releaseGroups.length === 0) {
						const appearances = await attempt(() =>
							musicBrainz.getRecordingReleaseGroups(anchor.mbid)
						);
						if (appearances.ok) group = pickGroup(appearances.value, retried);
					}
				}
				if (!group) {
					const sameNamed = await attempt(() =>
						musicBrainz.searchReleaseGroups({ artist, album: query, limit: SEARCH_LIMIT })
					);
					if (!sameNamed.ok) continue;
					group =
						sameNamed.value.find(
							(candidate) =>
								titlesMatch(entry.title, candidate.title) &&
								artistMatches(retried.artists, candidate.artist.name)
						) ?? null;
				}
				if (group) {
					addCandidate(candidates, group, retried, 'track', 'low');
					setSongMatch(artist, query, group);
					resolvedTracks += 1;
					unmatched.splice(unmatched.indexOf(entry), 1);
				} else {
					// Answered, and the answer is "nothing matches": that is a fact.
					entry.reason = 'no-match';
				}
			}
		}
	};

	await retryUnreachable();

	const list = [...candidates.values()].sort((a, b) => {
		// Albums with more of the user's songs first; that is what they will
		// recognise in the preview.
		if (b.tracks.length !== a.tracks.length) return b.tracks.length - a.tracks.length;
		return a.title.localeCompare(b.title);
	});
	markInLibrary(list);

	return { candidates: list, unmatched, resolvedTracks };
}

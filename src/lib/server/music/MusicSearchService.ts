import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, tracks } from '#lib/server/db/schema.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { getCategoriesForSearchType } from '#lib/server/indexers/types/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { NotFoundError } from '#lib/errors/index.js';
import {
	calculateTitleSimilarity,
	normalizeTitleForMatch
} from '#lib/server/library/title-matching.js';
import {
	gradeMusicRelease,
	type MusicQualityProfile
} from './parse-release.js';
import { musicProfileService } from './MusicProfileService.js';
import { parseMusicStreamUrl } from './stream-url.js';
import { blocklistService } from '#lib/server/blocklist/BlocklistService.js';

const logger = createChildLogger({ module: 'MusicSearchService', logDomain: 'system' });

const INTERACTIVE_SEARCH_TIMEOUT_MS = 45_000;

/** One candidate release for an album, as the interactive search shows it. */
export interface MusicReleaseCandidate {
	title: string;
	guid: string | null;
	indexerId: string | null;
	indexerName: string | null;
	protocol: string | null;
	size: number | null;
	seeders: number | null;
	leechers: number | null;
	categories: number[];
	downloadUrl: string | null;
	magnetUrl: string | null;
	infoHash: string | null;
	/** True when the release is filed under an audio category (3000-3999). */
	isAudioCategory: boolean;
	/** 0-1 similarity between the release title and the album being searched for. */
	relevance?: number;
	/** Parsed format (flac/mp3/…) so the UI can say what the release actually is. */
	format?: string;
	bitDepth?: number | null;
	/** Stated kbps, when the name gives one (often without a codec). */
	bitrateKbps?: number | null;
	sampleRateKhz?: number | null;
	/** Profile score, 0-1000, same scale as video profiles. */
	score?: number;
	/** False when the quality profile rejects it (no tier matches, size bounds…). */
	accepted?: boolean;
	/** Ladder rung, 0 = best; -1 when nothing matched. */
	tierIndex?: number;
	tierLabel?: string | null;
	/** Why it was rejected, when it was. */
	reasons?: string[];
}

/** Audio categories are the only ones worth offering for an album. */
export function isAudioCategory(category: number): boolean {
	return category >= 3000 && category < 4000;
}

/** Below this a title is a different record, not a sloppy match. */
const RELEVANCE_FLOOR = 0.55;

/**
 * Rank candidates for **one** album.
 *
 * Relevance comes first, and that ordering is the whole point: seeders alone
 * put a well-seeded *different* album by the same artist on top (measured —
 * "Human After All" with 156 seeders outranked the searched-for "Discovery"
 * with 251). So a release must plausibly be this album, then be audio, then be
 * well seeded, then be big.
 */
export function rankCandidates<T extends MusicReleaseCandidate>(candidates: T[]): T[] {
	return [...candidates].sort((a, b) => {
		// 1. Is it this album at all? A rejected FLAC of the wrong album is noise.
		const relevantA = (a.relevance ?? 0) >= RELEVANCE_FLOOR;
		const relevantB = (b.relevance ?? 0) >= RELEVANCE_FLOOR;
		if (relevantA !== relevantB) return relevantA ? -1 : 1;

		// 2. Does the quality profile accept it? Only then does quality matter.
		if ((a.accepted ?? true) !== (b.accepted ?? true)) return a.accepted ? -1 : 1;

		// 3. Quality is the ranking: the profile's ladder rung first, then the
		// tie-break score inside that rung. Seeders never outrank quality — a
		// fallback to a lower rung is `allowFallback` on the profile, not a
		// well-seeded worse copy.
		// `-1` means "no rung matched" everywhere else; a streaming release is
		// accepted without a rung, so both must sit below every real tier
		// rather than sorting first.
		const tierA = a.tierIndex !== undefined && a.tierIndex >= 0 ? a.tierIndex : 99;
		const tierB = b.tierIndex !== undefined && b.tierIndex >= 0 ? b.tierIndex : 99;
		const tier = tierA - tierB;
		if (tier !== 0) return tier;
		const score = (b.score ?? 0) - (a.score ?? 0);
		if (score !== 0) return score;

		// 4. Equal quality: category, then seeders (availability breaks ties only).
		if (a.isAudioCategory !== b.isAudioCategory) return a.isAudioCategory ? -1 : 1;
		const seeders = (b.seeders ?? 0) - (a.seeders ?? 0);
		if (seeders !== 0) return seeders;
		return (b.size ?? 0) - (a.size ?? 0);
	});
}

/**
 * Release titles carry year/format noise ("Daft Punk Discovery 2001 FLAC 88"), so
 * a whole-string similarity scores the right album badly. Containment on the
 * normalized album name is the useful signal; similarity is the fallback for a
 * misspelt or reordered title. Very short album names ("U") are excluded from
 * containment, where they would match half the catalogue.
 */
export function albumRelevance(releaseTitle: string, albumTitle: string): number {
	const hay = normalizeTitleForMatch(releaseTitle);
	const needle = normalizeTitleForMatch(albumTitle);
	if (!hay || !needle) return 0;
	if (needle.length >= 3 && hay.includes(needle)) return 1;
	return calculateTitleSimilarity(hay, needle);
}

/**
 * Below this a hit is a different album — the indexer matched one word of
 * "artist album" and returned the rest of its music catalogue. Measured on
 * "Chris Webby Asylum": 28 of 30 rows were other artists (relevance 0.05-0.11)
 * and drowned the two real releases (1.0).
 */
export const MIN_ALBUM_RELEVANCE = 0.5;

/** What a track-release title is allowed to contain to count as this song. */
export function trackRelevance(
	releaseTitle: string,
	trackTitle: string,
	albumTitle: string
): number {
	const hay = normalizeTitleForMatch(releaseTitle);
	const song = normalizeTitleForMatch(trackTitle);
	const album = normalizeTitleForMatch(albumTitle);
	if (!hay || !song) return 0;
	// A single names the song; an album rip names the album that contains it.
	if (song.length >= 3 && hay.includes(song)) return 1;
	if (album.length >= 3 && hay.includes(album)) return 0.9;
	return calculateTitleSimilarity(hay, song);
}

/** Drop the noise before it reaches the UI or the candidate count. */
export function relevantAlbumCandidates(
	candidates: MusicReleaseCandidate[]
): MusicReleaseCandidate[] {
	return candidates.filter((candidate) => (candidate.relevance ?? 0) >= MIN_ALBUM_RELEVANCE);
}

/**
 * Interactive release search for one stored album.
 *
 * This is the music counterpart of the movie/TV interactive search: it resolves
 * the album's artist and title from the library (never from the client), builds
 * MusicSearchCriteria — artist and album as separate fields, which is what the
 * indexer templates consume — and returns ranked candidates. It does not grab;
 * grabbing needs the download-monitor seam a music row does not have yet.
 */
export class MusicSearchService {
	async searchForAlbum(
		albumId: string,
		options: { limit?: number; profile?: MusicQualityProfile } = {}
	): Promise<{
		albumId: string;
		title: string;
		artist: string;
		profile: { id: string; name: string };
		candidates: MusicReleaseCandidate[];
	}> {
		const row = db
			.select({
				title: albums.title,
				year: albums.year,
				artist: artists.name
			})
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();
		if (!row) throw new NotFoundError('Album', albumId);

		// The album's own ladder, else its artist's, else the install default.
		const profile = options.profile ?? musicProfileService.resolveForAlbum(albumId);

		const manager = await getIndexerManager();
		const result = await manager.search(
			{
				searchType: 'music',
				query: `${row.artist} ${row.title}`,
				artist: row.artist,
				album: row.title,
				year: row.year ?? undefined,
				categories: getCategoriesForSearchType('music'),
				limit: options.limit ?? 30
			},
			{ searchSource: 'interactive', timeout: INTERACTIVE_SEARCH_TIMEOUT_MS }
		);

		const candidates = toCandidates(result.releases ?? [], profile, (release) =>
			albumRelevance(release.title, row.title)
		);

		const relevant = relevantAlbumCandidates(candidates);
		// A release this album already rejected must not come back on the next
		// search. The grab path checks again, so a direct guid grab cannot skip it.
		const blocked = await blocklistService.getBlockedIdentifiers(undefined, undefined, albumId);
		const allowed = relevant.filter(
			(candidate) =>
				!(candidate.infoHash && blocked.blockedHashes.has(candidate.infoHash)) &&
				!blocked.blockedTitles.has(candidate.title) &&
				// A stream candidate from the library indexer must name THIS album;
				// a same-titled album's stream would otherwise be selected.
				(candidate.protocol !== 'streaming' ||
					parseMusicStreamUrl(candidate.downloadUrl ?? '')?.albumId === albumId)
		);

		logger.info(
			{
				albumId,
				artist: row.artist,
				album: row.title,
				found: candidates.length,
				kept: relevant.length
			},
			'[MusicSearch] album release search'
		);

		return {
			albumId,
			title: row.title,
			artist: row.artist,
			profile: { id: profile.id, name: profile.name },
			candidates: rankCandidates(allowed)
		};
	}

	/**
	 * Interactive release search for one track — the music counterpart of the
	 * per-episode search. A song comes from a single that names it or from the
	 * album that contains it; both are matches, nothing else is.
	 */
	async searchForTrack(
		trackId: string,
		options: { limit?: number; profile?: MusicQualityProfile } = {}
	): Promise<{
		trackId: string;
		title: string;
		albumTitle: string;
		artist: string;
		profile: { id: string; name: string };
		candidates: MusicReleaseCandidate[];
	}> {
		const row = db
			.select({
				title: tracks.title,
				albumTitle: albums.title,
				year: albums.year,
				artist: artists.name,
				albumId: albums.id
			})
			.from(tracks)
			.innerJoin(albums, eq(tracks.albumId, albums.id))
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(tracks.id, trackId))
			.get();
		if (!row) throw new NotFoundError('Track', trackId);

		const profile = options.profile ?? musicProfileService.resolveForAlbum(row.albumId);

		const manager = await getIndexerManager();
		const result = await manager.search(
			{
				searchType: 'music',
				query: `${row.artist} ${row.title}`,
				artist: row.artist,
				album: row.albumTitle,
				year: row.year ?? undefined,
				categories: getCategoriesForSearchType('music'),
				limit: options.limit ?? 30
			},
			{ searchSource: 'interactive', timeout: INTERACTIVE_SEARCH_TIMEOUT_MS }
		);

		const candidates = toCandidates(result.releases ?? [], profile, (release) =>
			trackRelevance(release.title, row.title, row.albumTitle)
		);
		const relevant = relevantAlbumCandidates(candidates);

		logger.info(
			{
				trackId,
				artist: row.artist,
				track: row.title,
				album: row.albumTitle,
				found: candidates.length,
				kept: relevant.length
			},
			'[MusicSearch] track release search'
		);

		return {
			trackId,
			title: row.title,
			albumTitle: row.albumTitle,
			artist: row.artist,
			profile: { id: profile.id, name: profile.name },
			candidates: rankCandidates(relevant)
		};
	}

	/**
	 * Interactive release search for a whole discography — the music counterpart
	 * of the multi-season pack search. One query for the artist, then every hit
	 * is filed under the album it names; hits that name no album of theirs are
	 * noise and dropped.
	 */
	async searchForArtist(
		artistId: string,
		options: { limit?: number; profile?: MusicQualityProfile } = {}
	): Promise<{
		artistId: string;
		artist: string;
		candidates: Array<MusicReleaseCandidate & { albumId: string; albumTitle: string }>;
	}> {
		const profile = options.profile ?? musicProfileService.resolveForArtist(artistId);
		const artistRow = db
			.select({ name: artists.name })
			.from(artists)
			.where(eq(artists.id, artistId))
			.get();
		if (!artistRow) throw new NotFoundError('Artist', artistId);

		const albumRows = db
			.select({ id: albums.id, title: albums.title })
			.from(albums)
			.where(eq(albums.artistId, artistId))
			.all();
		if (albumRows.length === 0) {
			return { artistId, artist: artistRow.name, candidates: [] };
		}

		const manager = await getIndexerManager();
		const result = await manager.search(
			{
				searchType: 'music',
				query: artistRow.name,
				artist: artistRow.name,
				categories: getCategoriesForSearchType('music'),
				limit: options.limit ?? 60
			},
			{ searchSource: 'interactive', timeout: INTERACTIVE_SEARCH_TIMEOUT_MS }
		);

		const filed: Array<MusicReleaseCandidate & { albumId: string; albumTitle: string }> = [];
		for (const release of result.releases ?? []) {
			const match = bestAlbumMatch(release.title, albumRows);
			if (!match) continue;
			const [candidate] = toCandidates([release], profile, () => match.relevance);
			if (candidate)
				filed.push({ ...candidate, albumId: match.albumId, albumTitle: match.albumTitle });
		}

		logger.info(
			{
				artistId,
				artist: artistRow.name,
				albums: albumRows.length,
				found: (result.releases ?? []).length,
				kept: filed.length
			},
			'[MusicSearch] artist release search'
		);

		return { artistId, artist: artistRow.name, candidates: rankCandidates(filed) };
	}
}

/** The album a release belongs to, if any — the filing rule for a discography search. */
export function bestAlbumMatch(
	releaseTitle: string,
	albums: Array<{ id: string; title: string }>
): { albumId: string; albumTitle: string; relevance: number } | null {
	let best: { albumId: string; albumTitle: string; relevance: number } | null = null;
	for (const album of albums) {
		const relevance = albumRelevance(releaseTitle, album.title);
		if (!best || relevance > best.relevance) {
			best = { albumId: album.id, albumTitle: album.title, relevance };
		}
	}
	return best && best.relevance >= MIN_ALBUM_RELEVANCE ? best : null;
}

/** One mapping from an indexer hit to what the interactive rows render. */
function toCandidates(
	releases: Array<{
		title: string;
		guid?: string | null;
		indexerId?: string | null;
		indexerName?: string | null;
		protocol?: string | null;
		size?: number | null;
		seeders?: number | null;
		leechers?: number | null;
		categories?: number[] | null;
		downloadUrl?: string | null;
		magnetUrl?: string | null;
		infoHash?: string | null;
	}>,
	profile: MusicQualityProfile,
	relevanceOf: (release: { title: string }) => number
): MusicReleaseCandidate[] {
	return releases.map((release) => {
		const categories = (release.categories ?? []).map(Number);
		const grade = gradeMusicRelease(profile, {
			title: release.title,
			size: release.size ?? null,
			protocol: release.protocol ?? null
		});
		return {
			title: release.title,
			guid: release.guid ?? null,
			indexerId: release.indexerId ?? null,
			indexerName: release.indexerName ?? null,
			protocol: release.protocol ?? null,
			size: release.size ?? null,
			seeders: release.seeders ?? null,
			leechers: release.leechers ?? null,
			categories,
			downloadUrl: release.downloadUrl ?? null,
			magnetUrl: release.magnetUrl ?? null,
			infoHash: release.infoHash ?? null,
			isAudioCategory: categories.some(isAudioCategory),
			relevance: relevanceOf(release),
			format: grade.parsed.format,
			bitDepth: grade.parsed.bitDepth,
			bitrateKbps: grade.parsed.bitrateKbps,
			sampleRateKhz: grade.parsed.sampleRateKhz,
			score: grade.score,
			accepted: grade.accepted,
			tierIndex: grade.tierIndex,
			tierLabel: grade.tierLabel,
			reasons: grade.reasons
		} satisfies MusicReleaseCandidate;
	});
}

export const musicSearchService = new MusicSearchService();

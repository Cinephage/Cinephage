import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists } from '#lib/server/db/schema.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { getCategoriesForSearchType } from '#lib/server/indexers/types/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { NotFoundError } from '#lib/errors/index.js';
import {
	calculateTitleSimilarity,
	normalizeTitleForMatch
} from '#lib/server/library/title-matching.js';

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
		const relevantA = (a.relevance ?? 0) >= RELEVANCE_FLOOR;
		const relevantB = (b.relevance ?? 0) >= RELEVANCE_FLOOR;
		if (relevantA !== relevantB) return relevantA ? -1 : 1;
		if (relevantA && relevantB) {
			const relevance = (b.relevance ?? 0) - (a.relevance ?? 0);
			if (Math.abs(relevance) > 0.01) return relevance;
		}
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
		options: { limit?: number } = {}
	): Promise<{
		albumId: string;
		title: string;
		artist: string;
		candidates: MusicReleaseCandidate[];
	}> {
		const row = db
			.select({ title: albums.title, year: albums.year, artist: artists.name })
			.from(albums)
			.innerJoin(artists, eq(albums.artistId, artists.id))
			.where(eq(albums.id, albumId))
			.get();
		if (!row) throw new NotFoundError('Album', albumId);

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

		const candidates = (result.releases ?? []).map((release) => {
			const categories = (release.categories ?? []).map(Number);
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
				relevance: albumRelevance(release.title, row.title)
			} satisfies MusicReleaseCandidate;
		});

		logger.info(
			{ albumId, artist: row.artist, album: row.title, found: candidates.length },
			'[MusicSearch] album release search'
		);

		return {
			albumId,
			title: row.title,
			artist: row.artist,
			candidates: rankCandidates(candidates)
		};
	}
}

export const musicSearchService = new MusicSearchService();

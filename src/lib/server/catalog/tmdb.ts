import type { KindId } from '#lib/media-kinds/registry.js';
import { getDiscoverResults } from '#lib/server/discover.js';
import { tmdb } from '#lib/server/tmdb.js';
import type { CatalogItem, CatalogPage, CatalogSource } from './types.js';

interface TmdbRow {
	id: number;
	title?: string;
	name?: string;
	release_date?: string;
	first_air_date?: string;
	[key: string]: unknown;
}

interface TmdbPaginated {
	results: TmdbRow[];
	page: number;
	total_pages: number;
	total_results: number;
}

/** The kind a raw TMDB row carries, stamped by the endpoints that tag it or
 * by the branch that fetched it (discover endpoints do not tag). */
function rowKind(row: TmdbRow): KindId {
	return row.first_air_date !== undefined || (row.media_type as string | undefined) === 'tv'
		? 'tv'
		: 'movie';
}

function toItems(rows: TmdbRow[]): CatalogItem[] {
	return rows.map((row) => ({
		kind: rowKind(row),
		id: String(row.id),
		title: row.title ?? row.name ?? '',
		year: Number((row.release_date ?? row.first_air_date ?? '').slice(0, 4)) || null,
		meta: { ...row }
	}));
}

function toPage(data: TmdbPaginated, page: number): CatalogPage {
	return {
		items: toItems(data.results),
		pagination: {
			page,
			total_pages: data.total_pages,
			total_results: data.total_results
		}
	};
}

/** TMDB rows back to the legacy shape /api/discover has always returned. */
export function legacyRows(items: CatalogItem[]): Record<string, unknown>[] {
	return items.map((item) => ({
		...(item.meta ?? {}),
		id: Number(item.id),
		media_type: item.kind
	}));
}

/**
 * TMDB as a catalog source: movie and TV rows through the same engine the
 * page loader uses. The curated `top_rated` endpoint is TMDB's own grammar
 * and stays here; every other filter path runs through getDiscoverResults.
 */
export const tmdbCatalogSource: CatalogSource = {
	id: 'tmdb',
	kinds: ['movie', 'tv'],
	facets: [
		{ id: 'with_genres', label: 'Genre' },
		{ id: 'primary_release_date', label: 'Release date' },
		{ id: 'vote_average', label: 'Rating' },
		{ id: 'with_watch_providers', label: 'Watch provider' },
		{ id: 'with_networks', label: 'Network (TV)' },
		{ id: 'with_original_language', label: 'Original language' },
		{ id: 'certification', label: 'Certification (movies)' }
	],

	async discover(raw): Promise<CatalogPage | null> {
		// The route's zod schema validates this shape upstream.
		const params = raw as unknown as {
			type: string;
			page: number;
			sortBy: string;
			trending: 'day' | 'week' | null;
			topRated: 'true' | 'false' | null;
			withWatchProviders: string;
			watchRegion: string;
			withNetworks: string;
			withGenres: string;
			withKeywords: string;
			withoutKeywords: string;
			withOriginalLanguage: string | null;
			minDate: string | null;
			maxDate: string | null;
			minRating: string | null;
			certification: string | null;
			skipKeywordBlocklist: boolean;
		};

		if (params.topRated === 'true') {
			const page = params.page;
			if (params.type === 'movie') {
				const data = (await tmdb.fetch(`/movie/top_rated?page=${page}`)) as TmdbPaginated;
				return toPage({ ...data, results: stampKind(data.results, 'movie') }, page);
			}
			if (params.type === 'tv') {
				const data = (await tmdb.fetch(`/tv/top_rated?page=${page}`)) as TmdbPaginated;
				return toPage({ ...data, results: stampKind(data.results, 'tv') }, page);
			}
			const [movies, tv] = (await Promise.all([
				tmdb.fetch(`/movie/top_rated?page=${page}`),
				tmdb.fetch(`/tv/top_rated?page=${page}`)
			])) as TmdbPaginated[];
			const rows = [...stampKind(movies.results, 'movie'), ...stampKind(tv.results, 'tv')].sort(
				(a, b) => ((b.vote_average as number) ?? 0) - ((a.vote_average as number) ?? 0)
			);
			return {
				items: toItems(rows),
				pagination: {
					page: 1,
					total_pages: Math.max(movies.total_pages, tv.total_pages),
					total_results: movies.total_results + tv.total_results
				}
			};
		}

		const result = await getDiscoverResults({
			type: params.type,
			page: String(params.page),
			sortBy: params.sortBy,
			trending: params.trending ?? null,
			withWatchProviders: params.withWatchProviders,
			watchRegion: params.watchRegion ?? '',
			withNetworks: params.withNetworks,
			withGenres: params.withGenres,
			withKeywords: params.withKeywords,
			withoutKeywords: params.withoutKeywords,
			withOriginalLanguage: params.withOriginalLanguage,
			minDate: params.minDate,
			maxDate: params.maxDate,
			minRating: params.minRating,
			certification: params.certification,
			skipKeywordBlocklist: params.skipKeywordBlocklist ?? false
		});

		// getDiscoverResults stamps every row with media_type already.
		return {
			items: toItems(result.results as unknown as TmdbRow[]),
			pagination: result.pagination
		};
	}
};

/** Discover endpoints do not tag rows; the branch that fetched them knows. */
function stampKind(rows: TmdbRow[], kind: KindId): TmdbRow[] {
	return rows.map((row) => ({ ...row, media_type: kind }));
}

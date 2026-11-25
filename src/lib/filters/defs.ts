import type { KindFilter, KindId } from '#lib/media-kinds/registry.js';
import {
	idsParam,
	keywordsParams,
	numberParam,
	scalarParam,
	seasonalCodec,
	yearRangeParams
} from './codecs.js';
import type { FacetDef, FacetGroupId } from './types.js';

/**
 * The one place a Discover filter is declared.
 *
 * Each entry says which kinds offer it, which control renders it and how it
 * writes the URL. The panel and the server both read this list; nothing
 * outside it may hard-code a filter's parameter name.
 */

export interface SortOptionDef {
	id: string;
	labelKey: string;
}

const POPULARITY: SortOptionDef = {
	id: 'popularity.desc',
	labelKey: 'discover_sort_mostPopular'
};
const RATED: SortOptionDef = { id: 'vote_average.desc', labelKey: 'discover_sort_highestRated' };
const NEWEST: SortOptionDef = {
	id: 'primary_release_date.desc',
	labelKey: 'discover_sort_newestReleases'
};
const REVENUE: SortOptionDef = { id: 'revenue.desc', labelKey: 'discover_sort_highestRevenue' };

/** Sort is a source capability: TV has no revenue sort, music has no sort at all. */
export const SORT_OPTIONS: Record<KindId, readonly SortOptionDef[]> = {
	movie: [POPULARITY, RATED, NEWEST, REVENUE],
	tv: [POPULARITY, RATED, NEWEST],
	music: []
};

const MOVIE_TV: readonly KindId[] = ['movie', 'tv'];

const SORT: FacetDef = {
	id: 'sort',
	group: 'sort',
	control: 'single',
	kinds: MOVIE_TV,
	defaultValue: 'popularity.desc',
	codec: scalarParam('sort_by')
};

const GENRES: FacetDef = {
	id: 'genres',
	group: 'content',
	control: 'multi',
	kinds: MOVIE_TV,
	codec: idsParam('with_genres')
};

const SEASONAL: FacetDef = {
	id: 'seasonal',
	group: 'content',
	control: 'preset',
	kinds: MOVIE_TV,
	codec: seasonalCodec()
};

const KEYWORDS: FacetDef = {
	id: 'keywords',
	group: 'content',
	control: 'keywords',
	kinds: MOVIE_TV,
	codec: keywordsParams('with_keywords', 'without_keywords')
};

const LANGUAGE: FacetDef = {
	id: 'language',
	group: 'content',
	control: 'single',
	kinds: MOVIE_TV,
	// `none` is an explicit override of the instance-level stored origin
	// filter; clearing the control must actually clear the view.
	codec: scalarParam('with_original_language', { clearValue: 'none' })
};

const CERTIFICATION: FacetDef = {
	id: 'certification',
	group: 'content',
	control: 'single',
	kinds: ['movie'],
	codec: scalarParam('certification')
};

const YEAR: FacetDef = {
	id: 'year',
	group: 'release',
	control: 'range',
	kinds: MOVIE_TV,
	codec: yearRangeParams('primary_release_date.gte', 'primary_release_date.lte')
};

const RATING: FacetDef = {
	id: 'rating',
	group: 'release',
	control: 'slider',
	kinds: MOVIE_TV,
	codec: numberParam('vote_average.gte')
};

const PROVIDERS: FacetDef = {
	id: 'providers',
	group: 'availability',
	control: 'logo-multi',
	kinds: MOVIE_TV,
	codec: idsParam('with_watch_providers')
};

const NETWORKS: FacetDef = {
	id: 'networks',
	group: 'availability',
	control: 'logo-multi',
	kinds: ['tv'],
	codec: idsParam('with_networks')
};

/**
 * Music's genre is its own facet, not TMDB's with different options: the ids
 * belong to Deezer, so a value must not survive a tab switch into a video
 * kind. `genre` is the parameter the music landing shipped with; it is read
 * as a legacy alias and cleared on write.
 */
const MUSIC_GENRE: FacetDef = {
	id: 'music_genre',
	group: 'content',
	control: 'multi',
	kinds: ['music'],
	codec: idsParam('with_genres', { legacy: ['genre'] })
};

export const ALL_FACETS: readonly FacetDef[] = [
	SORT,
	GENRES,
	SEASONAL,
	KEYWORDS,
	LANGUAGE,
	CERTIFICATION,
	YEAR,
	RATING,
	PROVIDERS,
	NETWORKS,
	MUSIC_GENRE
];

/** Facet title keys. The server resolves them; this module stays i18n-free. */
export const FACET_LABELS: Record<string, string> = {
	sort: 'discover_filter_sortBy',
	genres: 'common_genres',
	seasonal: 'discover_seasonal_title',
	keywords: 'discover_filter_keywords',
	language: 'discover_filter_originalLanguage',
	certification: 'discover_filter_contentRating',
	year: 'discover_filter_releaseYear',
	rating: 'discover_filter_minRating',
	providers: 'discover_filter_watchProviders',
	networks: 'discover_filter_networks',
	music_genre: 'common_genres'
};

/** Bespoke badge wording, where "3 Genres" beats "Genres: 3". */
export const FACET_BADGES: Record<string, string> = {
	genres: 'discover_filterBadgeGenres',
	keywords: 'discover_filterBadgeKeywords',
	providers: 'discover_filterBadgeProviders',
	networks: 'discover_filterBadgeNetworks'
};

export const GROUP_LABELS: Record<FacetGroupId, string> = {
	sort: '',
	content: 'discover_filter_groupContent',
	release: 'discover_filter_groupRelease',
	availability: 'discover_filter_groupAvailability'
};

export const GROUP_ORDER: readonly FacetGroupId[] = ['sort', 'content', 'release', 'availability'];

/**
 * `all` filters the video kinds the All tab actually renders as a grid.
 * Music is a curated shelf on that tab, not a filterable grid, so its facets
 * stay on the Music tab.
 */
const ALL_FILTERED_KINDS: readonly KindId[] = ['movie', 'tv'];

export function facetsFor(kind: KindFilter): readonly FacetDef[] {
	if (kind === 'all') {
		return ALL_FACETS.filter((def) => def.kinds.some((id) => ALL_FILTERED_KINDS.includes(id)));
	}
	return ALL_FACETS.filter((def) => def.kinds.includes(kind));
}

export function facetById(id: string): FacetDef | undefined {
	return ALL_FACETS.find((def) => def.id === id);
}

import type { SearchParam, SearchMode, IndexerCapabilities, SearchFormats } from './types';
import { resolveCategoryId } from './schema/yamlDefinition';

const PARAM_MAPPING: Record<string, SearchParam> = {
	q: 'q',
	imdbid: 'imdbId',
	tmdbid: 'tmdbId',
	tvdbid: 'tvdbId',
	tvmazeid: 'tvMazeId',
	traktid: 'traktId',
	season: 'season',
	ep: 'ep',
	year: 'year',
	genre: 'genre',
	artist: 'artist',
	album: 'album',
	author: 'author',
	title: 'title'
};

function toSearchParams(params: string[] | undefined): SearchParam[] {
	if (!params) return ['q'];
	return params.map((p) => PARAM_MAPPING[p.toLowerCase()] ?? ('q' as SearchParam));
}

function buildSearchMode(params: string[] | undefined): SearchMode {
	return {
		available: params !== undefined && params.length > 0,
		supportedParams: toSearchParams(params)
	};
}

export interface BuildCapabilitiesInput {
	modes: Record<string, string[]>;
	categories?: Record<string, string>;
	categorymappings?: Array<{ cat?: string; desc?: string }>;
	supportsInfoHash?: boolean;
	/**
	 * Per-indexer query formats from the definition's `caps.searchFormats`.
	 * Dropping this here is what made a YAML declaration a no-op: the search
	 * orchestrator reads capabilities.searchFormats to decide which episode
	 * token variants to try, so a definition that declares none kept getting
	 * `S01` jammed into its free-text query.
	 */
	searchFormats?: { episode?: string[]; movie?: string[] };
}

export function buildCapabilitiesFromYaml(input: BuildCapabilitiesInput): IndexerCapabilities {
	const {
		modes = {},
		categories: cats,
		categorymappings,
		supportsInfoHash = true,
		searchFormats
	} = input;

	const categoryMap = new Map<number, string>();
	if (cats) {
		for (const [catId, catName] of Object.entries(cats)) {
			const numId = parseInt(catId, 10);
			if (!isNaN(numId)) {
				categoryMap.set(numId, catName);
			}
		}
	}
	if (categorymappings) {
		for (const mapping of categorymappings) {
			if (mapping.cat) {
				const numId = resolveCategoryId(mapping.cat);
				categoryMap.set(numId, mapping.desc ?? mapping.cat);
			}
		}
	}

	return {
		search: modes['search']
			? buildSearchMode(modes['search'])
			: { available: true, supportedParams: ['q'] },
		movieSearch: modes['movie-search'] ? buildSearchMode(modes['movie-search']) : undefined,
		tvSearch: modes['tv-search'] ? buildSearchMode(modes['tv-search']) : undefined,
		musicSearch: modes['music-search'] ? buildSearchMode(modes['music-search']) : undefined,
		bookSearch: modes['book-search'] ? buildSearchMode(modes['book-search']) : undefined,
		categories: categoryMap,
		supportsPagination: false,
		supportsInfoHash,
		limitMax: 100,
		limitDefault: 100,
		searchFormats: searchFormats
			? {
					episode: searchFormats.episode as SearchFormats['episode'],
					movie: searchFormats.movie as SearchFormats['movie']
				}
			: undefined
	};
}

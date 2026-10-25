/**
 * Request builder for YAML indexer definitions.
 * Builds HTTP requests from definition search paths and criteria.
 */

import type {
	YamlDefinition as CardigannDefinition,
	SearchBlock,
	SearchPathBlock
} from '../schema/yamlDefinition';
import { resolveCategoryId } from '../schema/yamlDefinition';
import type { SearchCriteria } from '../types';
import { getCategoriesForSearchType, isMovieSearch, isTvSearch } from '../types';
import { TemplateEngine } from '../engine/TemplateEngine';
import { FilterEngine } from '../engine/FilterEngine';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import { encodeUrlParam } from '../http/EncodingUtils';

/**
 * HTTP request representation.
 */
export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: string | URLSearchParams;
	searchPath: SearchPathBlock | null;
}

/**
 * Category mapper for converting between Newznab and tracker-specific categories.
 */
export class CategoryMapper {
	private definition: CardigannDefinition;
	private trackerToNewznab: Map<string, number[]> = new Map();
	private newznabToTracker: Map<number, string[]> = new Map();
	private defaultCategories: string[] = [];

	constructor(definition: CardigannDefinition) {
		this.definition = definition;
		this.buildMappings();
	}

	private buildMappings(): void {
		const caps = this.definition.caps;

		// Process simple categories (id -> name)
		if (caps.categories) {
			for (const [trackerId, catName] of Object.entries(caps.categories)) {
				const newznabId = this.getNewznabIdByName(catName);
				if (newznabId !== null) {
					this.addMapping(trackerId, newznabId);
				} else {
					// Fallback for subcategories absent from the name table (e.g. XXX subcategories):
					// Newznab/Torznab indexers use numeric tracker IDs that equal Newznab IDs directly,
					// so we can use the numeric value when the name lookup yields nothing.
					const directId = parseInt(trackerId, 10);
					if (!isNaN(directId) && directId >= 1000 && directId <= 8999) {
						this.addMapping(trackerId, directId);
					}
				}
			}
		}

		// Process categorymappings (more detailed)
		if (caps.categorymappings) {
			for (const mapping of caps.categorymappings) {
				if (mapping.cat) {
					const newznabId = resolveCategoryId(mapping.cat);
					this.addMapping(mapping.id, newznabId);
				}

				if (mapping.default) {
					this.defaultCategories.push(mapping.id);
				}
			}
		}
	}

	private addMapping(trackerId: string, newznabId: number): void {
		// Tracker to Newznab
		const existing = this.trackerToNewznab.get(trackerId) ?? [];
		if (!existing.includes(newznabId)) {
			existing.push(newznabId);
			this.trackerToNewznab.set(trackerId, existing);
		}

		// Newznab to Tracker
		const reverse = this.newznabToTracker.get(newznabId) ?? [];
		if (!reverse.includes(trackerId)) {
			reverse.push(trackerId);
			this.newznabToTracker.set(newznabId, reverse);
		}
	}

	/**
	 * Resolve a Newznab category name to its numeric ID.
	 * Public so RequestBuilder can use it for path matching.
	 */
	getNewznabIdByName(name: string): number | null {
		// Standard Newznab category mappings
		const mapping: Record<string, number> = {
			Console: 1000,
			Movies: 2000,
			'Movies/Foreign': 2010,
			'Movies/Other': 2020,
			'Movies/SD': 2030,
			'Movies/HD': 2040,
			'Movies/UHD': 2045,
			'Movies/BluRay': 2050,
			'Movies/3D': 2060,
			'Movies/DVD': 2070,
			'Movies/WEB-DL': 2080,
			Audio: 3000,
			'Audio/MP3': 3010,
			'Audio/Video': 3020,
			'Audio/Audiobook': 3030,
			'Audio/Lossless': 3040,
			'Audio/Other': 3050,
			'Audio/Foreign': 3060,
			PC: 4000,
			'PC/0day': 4010,
			'PC/ISO': 4020,
			'PC/Mac': 4030,
			'PC/Games': 4050,
			TV: 5000,
			'TV/WEB-DL': 5010,
			'TV/Foreign': 5020,
			'TV/SD': 5030,
			'TV/HD': 5040,
			'TV/UHD': 5045,
			'TV/Other': 5050,
			'TV/Sport': 5060,
			'TV/Anime': 5070,
			'TV/Documentary': 5080,
			XXX: 6000,
			'XXX/DVD': 6010,
			'XXX/WMV': 6020,
			'XXX/XviD': 6030,
			'XXX/x264': 6040,
			'XXX/UHD': 6045,
			'XXX/Pack': 6050,
			'XXX/ImgSet': 6060,
			'XXX/Other': 6070,
			'XXX/SD': 6080,
			'XXX/x265': 6090,
			Books: 7000,
			'Books/EBook': 7020,
			'Books/Comics': 7030,
			Other: 8000
		};

		return mapping[name] ?? null;
	}

	/**
	 * Check if a tracker category ID falls under a parent Newznab category.
	 * Newznab uses ranges: 2xxx = Movies, 5xxx = TV, etc.
	 */
	categoryMatchesParent(trackerCatId: string, parentNewznabId: number): boolean {
		const trackerId = parseInt(trackerCatId, 10);
		if (isNaN(trackerId)) return false;

		// Get the parent range (thousands digit)
		const parentRange = Math.floor(parentNewznabId / 1000) * 1000;
		const trackerRange = Math.floor(trackerId / 1000) * 1000;

		return parentRange === trackerRange;
	}

	/**
	 * Map Newznab category IDs to tracker-specific category IDs.
	 */
	mapToTracker(newznabIds: number[]): string[] {
		// Empty input means explicit open search — return no filter, not the defaults
		if (newznabIds.length === 0) return [];

		const trackerIds: string[] = [];

		for (const newznabId of newznabIds) {
			const mapped = this.newznabToTracker.get(newznabId);
			if (mapped) {
				for (const trackerId of mapped) {
					if (!trackerIds.includes(trackerId)) {
						trackerIds.push(trackerId);
					}
				}
			}
		}

		if (trackerIds.length > 0) return trackerIds;

		// None of the requested categories are mapped for this indexer. Falling back
		// to every `default: true` category is wrong when they span more than one
		// content type (e.g. a generic Movies default AND a generic TV default) - it
		// would silently widen a TV-scoped search into also querying Movies (or vice
		// versa). Only keep defaults whose own Newznab range matches what was
		// actually requested; if none match either, omit the filter entirely rather
		// than guess a wrong content type.
		return this.defaultCategories.filter((trackerId) =>
			newznabIds.some((id) => this.categoryMatchesParent(trackerId, id))
		);
	}

	/**
	 * Get default tracker categories.
	 */
	getDefaults(): string[] {
		return this.defaultCategories;
	}

	/**
	 * Map a tracker-specific category ID to all matching Newznab category IDs.
	 * Returns an array because a single tracker category can map to multiple Newznab categories
	 * (e.g., Nyaa.si's "1_2" anime category maps to both TV/Anime and Movies/Other).
	 */
	mapFromTracker(trackerId: string): number[] {
		return this.trackerToNewznab.get(trackerId) ?? [];
	}
}

export class RequestBuilder {
	private definition: CardigannDefinition;
	private templateEngine: TemplateEngine;
	private filterEngine: FilterEngine;
	private categoryMapper: CategoryMapper;
	private baseUrl: string;
	/** Supported params per search mode (e.g. 'movie' -> ['q', 'imdbid']) */
	private supportedParams: Map<string, string[]> = new Map();
	/** Override for the 'limit' input — set from live indexer caps */
	private limitOverride: number | null = null;

	constructor(
		definition: CardigannDefinition,
		templateEngine: TemplateEngine,
		filterEngine: FilterEngine
	) {
		this.definition = definition;
		this.templateEngine = templateEngine;
		this.filterEngine = filterEngine;
		this.categoryMapper = new CategoryMapper(definition);
		this.baseUrl = definition.links[0];
	}

	/**
	 * Set supported params for a search mode.
	 * Used by Newznab indexers to filter out unsupported params.
	 * @param mode The search mode (e.g. 'search', 'movie', 'tvsearch')
	 * @param params List of supported parameter names (lowercase)
	 */
	setSupportedParams(mode: string, params: string[]): void {
		this.supportedParams.set(mode, params);
	}

	/**
	 * Override the 'limit' input for all search requests.
	 * Called with the indexer's reported limits.max from live caps so we ask
	 * for as many results as the indexer supports rather than a hardcoded value.
	 */
	setLimitOverride(limit: number): void {
		this.limitOverride = limit;
	}

	/**
	 * Set the base URL (can be overridden from settings).
	 */
	setBaseUrl(url: string): void {
		this.baseUrl = url;
		this.templateEngine.setSiteLink(url);
	}

	/**
	 * Build search requests for the given criteria.
	 */
	buildSearchRequests(criteria: SearchCriteria): HttpRequest[] {
		const search = this.definition.search;
		const requests: HttpRequest[] = [];
		const seenUrls = new Set<string>();

		// Path selection always uses content-type defaults (t=movie for movies, t=tvsearch for TV).
		// Stripping criteria.categories before calling withDefaultCategories ensures the right search
		// mode path is chosen regardless of any per-indexer category restriction.
		const pathCriteria = this.withDefaultCategories({ ...criteria, categories: undefined });
		const pathTrackerCats = this.categoryMapper.mapToTracker(pathCriteria.categories ?? []);

		// Determine what to put in the cat= URL parameter (separate from path routing):
		//   criteria.categories === undefined → no restriction; mirror path-selection categories
		//   criteria.categories === []        → explicit open search; omit cat= entirely
		//   criteria.categories === [...]     → user restriction; use exactly those IDs
		const catTrackerIds =
			criteria.categories === undefined
				? pathTrackerCats
				: criteria.categories.length === 0
					? []
					: this.categoryMapper.mapToTracker(criteria.categories);

		// Set query and category template variables
		this.templateEngine.setQuery(pathCriteria);
		this.templateEngine.setCategories(catTrackerIds);

		// Use keywords produced by TemplateEngine.setQuery() as the source of truth.
		// This preserves TV episode tokens (e.g., S01E05 / 1x05 / 105) that are
		// injected based on preferredEpisodeFormat.
		const queryKeywordsVar = this.templateEngine.getVariable('.Query.Keywords');
		const queryKeywords =
			typeof queryKeywordsVar === 'string' && queryKeywordsVar.length > 0
				? queryKeywordsVar
				: this.buildKeywords(pathCriteria);
		this.templateEngine.setVariable('.Query.Keywords', queryKeywords);
		this.templateEngine.setVariable('.Keywords', this.applyKeywordsFilters(queryKeywords, search));
		this.templateEngine.setVariable('.Categories', catTrackerIds);
		this.templateEngine.setVariable('.Query.IdTokens', this.buildIdTokens(pathCriteria));

		// Get search paths — filtered by content-type, not by the category restriction
		const paths = this.getSearchPaths(search);
		const filteredPaths = this.filterPathsForSearchType(paths, pathCriteria, pathTrackerCats);

		for (const path of filteredPaths) {
			const request = this.buildRequestForPath(path, search, catTrackerIds);
			if (request && !seenUrls.has(request.url)) {
				seenUrls.add(request.url);
				requests.push(request);
			}
		}

		return requests;
	}

	/**
	 * Apply category defaults from search type when caller does not provide categories.
	 *
	 * Without this fallback, RequestBuilder falls back to indexer category defaults
	 * (from categorymappings.default), which can select the wrong content type.
	 */
	private withDefaultCategories(criteria: SearchCriteria): SearchCriteria {
		// undefined  → fill in content-type defaults
		// []         → explicit open search (no cat= param) — do not override
		// [...]      → explicit restriction — do not override
		if (criteria.categories !== undefined) {
			return criteria;
		}

		if (criteria.searchType === 'basic') {
			return criteria;
		}

		return {
			...criteria,
			categories: getCategoriesForSearchType(criteria.searchType)
		};
	}

	/**
	 * Filter candidate paths for a search.
	 *
	 * For typed searches (movie/tv/music/book), prefer category-scoped paths when available.
	 * This avoids firing both specific and generic fallback paths in the same request cycle.
	 */
	private filterPathsForSearchType(
		paths: SearchPathBlock[],
		criteria: SearchCriteria,
		trackerCategories: string[]
	): SearchPathBlock[] {
		const hadRequestedCategories = (criteria.categories ?? []).length > 0;
		const matchingPaths = paths.filter((path) =>
			this.pathMatchesCategories(path, trackerCategories, hadRequestedCategories)
		);

		if (criteria.searchType === 'basic') {
			const genericPaths = matchingPaths.filter(
				(path) => !Array.isArray(path.categories) || path.categories.length === 0
			);
			// For plain text search, prefer generic paths and avoid category-specific variants.
			return genericPaths.length > 0 ? genericPaths : matchingPaths;
		}

		const categoryScopedPaths = matchingPaths.filter(
			(path) =>
				Array.isArray(path.categories) && path.categories.length > 0 && path.categories[0] !== '!'
		);

		// If specific category-scoped paths exist, skip generic fallbacks.
		if (categoryScopedPaths.length > 0) {
			return categoryScopedPaths;
		}

		return matchingPaths;
	}

	/**
	 * Build keywords string from search criteria.
	 *
	 * Note: Episode tokens are now handled by TemplateEngine.setQuery() which
	 * sets .Keywords to include the episode token based on criteria.preferredEpisodeFormat.
	 * This method is kept for backwards compatibility and for the movie year case.
	 *
	 * The actual .Keywords value used in templates comes from TemplateEngine,
	 * not from this method's return value (see buildSearchRequests where we
	 * call templateEngine.setQuery() first).
	 */
	private buildKeywords(criteria: SearchCriteria): string {
		const parts: string[] = [];

		if (criteria.query) {
			parts.push(criteria.query);
		}

		// Movie year handling - add year if not already in query
		if (isMovieSearch(criteria)) {
			if (criteria.year) {
				if (!criteria.query?.includes(String(criteria.year))) {
					parts.push(String(criteria.year));
				}
			}
		}

		// Note: TV episode tokens are NOT added here anymore.
		// TemplateEngine is the sole source of truth for episode token composition.
		// It uses criteria.preferredEpisodeFormat to determine which format to add.

		return parts.join(' ');
	}

	/**
	 * Build Prowlarr query tokens ("{ImdbId:tt0111161} {Season:1} {Episode:5}") for
	 * the criteria's IDs.
	 *
	 * Prowlarr's search API ignores separate imdbId/tmdbId params and only reads
	 * IDs embedded in the query as tokens. It also skips a tracker outright when
	 * asked for an ID the tracker doesn't support, so only IDs confirmed by live
	 * caps are emitted — and none at all when the supported params are unknown.
	 * Season/episode tokens only accompany an ID; on their own they are not an
	 * ID search. Returns '' when there is nothing to emit.
	 */
	private buildIdTokens(criteria: SearchCriteria): string {
		const isMovie = isMovieSearch(criteria);
		const isTv = isTvSearch(criteria);
		if (!isMovie && !isTv) return '';
		const supported = this.supportedParams.get(isMovie ? 'movie' : 'tvsearch');
		if (!supported) return '';

		const tokens: string[] = [];
		const addToken = (param: string, token: string, value: string | number | undefined) => {
			if (value === undefined || value === '' || !supported.includes(param)) return;
			tokens.push(`{${token}:${value}}`);
		};

		if (criteria.imdbId) {
			const imdbId = criteria.imdbId.startsWith('tt') ? criteria.imdbId : `tt${criteria.imdbId}`;
			addToken('imdbid', 'ImdbId', imdbId);
		}
		addToken('tmdbid', 'TmdbId', criteria.tmdbId);
		if (isTv) {
			addToken('tvdbid', 'TvdbId', criteria.tvdbId);
			addToken('tvmazeid', 'TvMazeId', criteria.tvMazeId);
		}
		if (tokens.length === 0) return '';

		if (isTv) {
			addToken('season', 'Season', criteria.season);
			addToken('ep', 'Episode', criteria.episode);
		}
		return tokens.join(' ');
	}

	/**
	 * Apply keywords filters from search definition.
	 */
	private applyKeywordsFilters(keywords: string, search: SearchBlock): string {
		if (!search.keywordsfilters) {
			return keywords;
		}
		return this.filterEngine.applyFilters(keywords, search.keywordsfilters);
	}

	/**
	 * Get search paths from definition.
	 */
	private getSearchPaths(search: SearchBlock): SearchPathBlock[] {
		if (search.paths && search.paths.length > 0) {
			return search.paths;
		}

		// Create path from legacy single path
		if (search.path) {
			return [
				{
					path: search.path,
					method: 'get',
					inputs: search.inputs
				}
			];
		}

		return [];
	}

	/**
	 * Check if path categories match the requested categories.
	 * Handles both numeric category IDs and category names (like "Movies", "TV").
	 */
	private pathMatchesCategories(
		path: SearchPathBlock,
		trackerCategories: string[],
		hadRequestedCategories: boolean
	): boolean {
		if (!path.categories || path.categories.length === 0) {
			return true; // No category restriction
		}

		if (trackerCategories.length === 0) {
			// Two different situations collapse to the same empty array here:
			//  - No categories were requested at all (basic/open search) -> match
			//    every path, including category-scoped ones.
			//  - A typed search DID request categories (e.g. TV_CATEGORIES), but
			//    this indexer has no mapping for any of them - CategoryMapper's
			//    own fallback already came up empty. That's "this indexer doesn't
			//    support the requested content type", not "no restriction"; a
			//    category-scoped path (e.g. a Movies-only path) must not be
			//    treated as a match just because nothing else fit, or a TV search
			//    ends up firing against a movie-only indexer/path.
			return !hadRequestedCategories;
		}

		// Check for exclusion (category list starting with "!")
		if (path.categories[0] === '!') {
			const excluded = path.categories.slice(1);
			return !this.categoriesMatch(trackerCategories, excluded);
		}

		// Check for inclusion
		return this.categoriesMatch(trackerCategories, path.categories);
	}

	/**
	 * Check if any of the tracker categories match the path categories.
	 * Handles both numeric IDs and category names.
	 */
	private categoriesMatch(trackerCategories: string[], pathCategories: string[]): boolean {
		for (const pathCat of pathCategories) {
			// Check if pathCat is a name (non-numeric) or an ID (numeric)
			if (/^\d+$/.test(pathCat)) {
				// Numeric ID - direct match
				if (trackerCategories.includes(pathCat)) {
					return true;
				}
			} else {
				// Category name - resolve to parent ID and check range
				const parentId = this.categoryMapper.getNewznabIdByName(pathCat);
				if (parentId !== null) {
					// Check if any tracker category falls under this parent
					for (const trackerCat of trackerCategories) {
						if (this.categoryMapper.categoryMatchesParent(trackerCat, parentId)) {
							return true;
						}
					}
				}
			}
		}
		return false;
	}

	/**
	 * Build HTTP request for a single search path.
	 */
	private buildRequestForPath(
		path: SearchPathBlock,
		search: SearchBlock,
		trackerCategories: string[]
	): HttpRequest | null {
		// Update categories variable for this path
		if (path.categories && path.categories.length > 0 && path.categories[0] !== '!') {
			// Use intersection of requested and path categories
			const intersection = trackerCategories.filter((c) => path.categories!.includes(c));
			if (intersection.length > 0) {
				this.templateEngine.setCategories(intersection);
			}
		}

		// Expand path template
		const pathStr = this.templateEngine.expand(path.path || '', encodeURIComponent);

		// Build base URL
		let url = this.resolveUrl(pathStr);

		// Collect inputs
		const inputs: Record<string, string> = {};

		// Global inputs (if inheritinputs is not false)
		if (path.inheritinputs !== false && search.inputs) {
			for (const [key, value] of Object.entries(search.inputs)) {
				const expanded = this.expandInput(key, value);
				if (expanded !== null) {
					inputs[key] = expanded;
				}
			}
		}

		// Path-specific inputs
		if (path.inputs) {
			for (const [key, value] of Object.entries(path.inputs)) {
				const expanded = this.expandInput(key, value);
				if (expanded !== null) {
					inputs[key] = expanded;
				}
			}
		}

		// Filter inputs by supported params (for Newznab)
		// Uses the 't' param value to determine search mode (e.g., 'movie', 'tvsearch').
		// Without a 't' param the inputs aren't Newznab params (e.g. Prowlarr's JSON
		// API, which carries IDs as query tokens), so there is nothing to filter.
		const filteredInputs = inputs['t'] ? this.filterBySupportedParams(inputs, inputs['t']) : inputs;

		// Skip paths that have no meaningful search criteria after filtering
		// (only standard params like t, apikey, limit, cat remain - no actual search params)
		// EXCEPTION: If the path template contains .Keywords, the search is embedded in the URL path
		const meaningfulSearchParams = [
			'q',
			'query',
			'query_term',
			'name', // UNIT3D trackers use 'name' for keyword search
			'search',
			's', // Kinozal uses 's' for keyword search
			'nm', // RuTracker uses 'nm' for keyword search
			'mire', // nCore uses 'mire' for keyword search
			'imdb', // Some trackers use 'imdb' instead of 'imdbid'
			'imdbid',
			'imdb_id',
			'tmdb', // Some trackers use 'tmdb' instead of 'tmdbid'
			'tmdbid',
			'tmdb_id',
			'tvdb', // Some trackers use 'tvdb' instead of 'tvdbid'
			'tvdbid',
			'tvdb_id',
			'tvmazeid',
			'rid',
			'season',
			'ep',
			'artist',
			'album',
			'author',
			'title'
		];
		const hasInputSearchCriteria = Object.entries(filteredInputs).some(
			([key, value]) =>
				meaningfulSearchParams.includes(key.toLowerCase()) &&
				this.isMeaningfulSearchInputValue(key, value)
		);
		// Check if the path template contains keywords placeholder (e.g., {{ .Keywords }})
		// This allows indexers that embed search in the URL path
		const pathHasKeywords = path.path?.includes('.Keywords') ?? false;
		if (!hasInputSearchCriteria && !pathHasKeywords) {
			return null;
		}

		// Determine method
		const method = (path.method?.toUpperCase() === 'POST' ? 'POST' : 'GET') as 'GET' | 'POST';

		// Build headers
		const headers: Record<string, string> = {};
		if (search.headers) {
			for (const [key, value] of Object.entries(search.headers)) {
				const headerValue = Array.isArray(value) ? value[0] : value;
				headers[key] = this.templateEngine.expand(headerValue);
			}
		}

		// Build request
		const encoding = this.definition.encoding;
		if (method === 'GET') {
			// Add inputs as query parameters with proper encoding
			const queryParts: string[] = [];
			for (const [key, value] of Object.entries(filteredInputs)) {
				if (key === '$raw') {
					// Raw query string, parse and add
					const rawParts = value.split('&');
					for (const part of rawParts) {
						const [k, v] = part.split('=');
						if (k) {
							const encodedK = encodeUrlParam(k, encoding);
							const encodedV = v ? encodeUrlParam(v, encoding) : '';
							queryParts.push(`${encodedK}=${encodedV}`);
						}
					}
				} else {
					const encodedKey = encodeUrlParam(key, encoding);
					const encodedValue = encodeUrlParam(value, encoding);
					queryParts.push(`${encodedKey}=${encodedValue}`);
				}
			}

			const queryString = queryParts.join('&');
			if (queryString) {
				url += (url.includes('?') ? '&' : '?') + queryString;
			}

			return { url, method, headers, searchPath: path };
		} else {
			// POST - inputs go in body
			const contentType = headers['Content-Type'] || headers['content-type'] || '';

			if (contentType.includes('application/json')) {
				// JSON body - serialize inputs as JSON object
				const jsonBody: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(filteredInputs)) {
					// Try to parse JSON values (arrays, numbers, booleans)
					try {
						jsonBody[key] = JSON.parse(value);
					} catch {
						jsonBody[key] = value;
					}
				}
				return { url, method, headers, body: JSON.stringify(jsonBody), searchPath: path };
			} else {
				// Form-encoded body (default) with proper encoding
				const bodyParts: string[] = [];
				for (const [key, value] of Object.entries(filteredInputs)) {
					if (key === '$raw') {
						const rawParts = value.split('&');
						for (const part of rawParts) {
							const [k, v] = part.split('=');
							if (k) {
								const encodedK = encodeUrlParam(k, encoding);
								const encodedV = v ? encodeUrlParam(v, encoding) : '';
								bodyParts.push(`${encodedK}=${encodedV}`);
							}
						}
					} else {
						const encodedKey = encodeUrlParam(key, encoding);
						const encodedValue = encodeUrlParam(value, encoding);
						bodyParts.push(`${encodedKey}=${encodedValue}`);
					}
				}
				const body = bodyParts.join('&');
				return { url, method, headers, body, searchPath: path };
			}
		}
	}

	/**
	 * Filter inputs to only include supported params for the given search mode.
	 * Always allows certain standard params like 't', 'apikey', 'limit', etc.
	 */
	private filterBySupportedParams(
		inputs: Record<string, string>,
		mode: string
	): Record<string, string> {
		const supported = this.supportedParams.get(mode);
		logger.debug(
			{
				mode,
				supportedParams: supported ?? []
			},
			'[RequestBuilder] filterBySupportedParams'
		);
		if (!supported || supported.length === 0) {
			// No filtering configured for this mode
			return inputs;
		}

		const filtered: Record<string, string> = {};
		// Standard params that are always allowed (not search-mode specific)
		const alwaysAllow = ['t', 'apikey', 'limit', 'cat', 'extended', 'offset', 'attrs', '$raw'];

		for (const [key, value] of Object.entries(inputs)) {
			const lowerKey = key.toLowerCase();

			// Always allow standard params
			if (alwaysAllow.includes(lowerKey)) {
				filtered[key] = value;
				continue;
			}

			// Only include if in supported params list
			if (supported.includes(lowerKey)) {
				filtered[key] = value;
			}
		}

		return filtered;
	}

	/**
	 * Expand an input value with templates.
	 */
	private expandInput(key: string, template: string): string | null {
		// When a live-caps limit override is set, use it instead of the static value
		// in the YAML so we ask for as many results as the indexer actually supports.
		if (key.toLowerCase() === 'limit' && this.limitOverride !== null) {
			return String(this.limitOverride);
		}

		const expanded = this.templateEngine.expand(template);

		// Check allowEmptyInputs
		if (!expanded && !this.definition.search.allowEmptyInputs) {
			// Don't include empty inputs unless allowed
			return null;
		}

		return expanded;
	}

	/**
	 * Check if a search input value is meaningful enough to execute.
	 *
	 * Prevents degenerate TV queries where keyword filters strip the title and
	 * leave only episode tokens (e.g. "%S01", "%S01E01", "%1x01", "%101"),
	 * which can flood results with unrelated releases.
	 */
	private isMeaningfulSearchInputValue(key: string, value: string): boolean {
		const trimmed = value.trim();
		if (!trimmed) return false;

		const lowerKey = key.toLowerCase();
		const keywordKeys = new Set(['q', 'query', 'query_term', 'name', 'search', 's', 'nm', 'mire']);
		if (!keywordKeys.has(lowerKey)) {
			return true;
		}

		const tokens = trimmed.match(/[\p{L}\p{N}x]+/giu) ?? [];
		if (tokens.length === 0) {
			return false;
		}

		const isEpisodeOnlyToken = (token: string): boolean => {
			return (
				/^s\d{1,2}$/i.test(token) ||
				/^e\d{1,3}(?:-\d{1,3})?$/i.test(token) ||
				/^s\d{1,2}e\d{1,3}$/i.test(token) ||
				/^\d{1,2}x\d{1,3}$/i.test(token) ||
				/^\d{3}$/.test(token)
			);
		};

		return !tokens.every((token) => isEpisodeOnlyToken(token));
	}

	/**
	 * Resolve a path to an absolute URL.
	 */
	private resolveUrl(path: string): string {
		if (path.startsWith('http://') || path.startsWith('https://')) {
			return path;
		}

		try {
			// Torznab paths are always empty strings — the base URL IS the endpoint.
			// Jackett URLs like http://host/torznab/all must end with /api, but users often omit it.
			// Apply the same normalization that the caps-fetch does so searches hit the right endpoint.
			if (this.definition.id === 'torznab' && !path) {
				const base = new URL(this.baseUrl);
				const normalizedPath = base.pathname.replace(/\/+$/, '');
				const lowerPath = normalizedPath.toLowerCase();
				const isTorznabEndpoint =
					lowerPath.endsWith('/torznab') || lowerPath.includes('/results/torznab');
				if (!isTorznabEndpoint && !lowerPath.endsWith('/api')) {
					base.pathname = normalizedPath ? `${normalizedPath}/api` : '/api';
				}
				return base.toString();
			}

			// Newznab endpoints are commonly hosted under a sub-path (e.g., /newznab).
			// Keep that base path when definition paths are absolute like "/api".
			if (this.definition.id === 'newznab' && path.startsWith('/')) {
				const base = new URL(this.baseUrl);
				const normalizedBasePath = base.pathname.replace(/\/+$/, '');
				const normalizedPath = path.replace(/\/+$/, '');

				if (normalizedBasePath && normalizedBasePath !== '/') {
					// If base URL already includes the target endpoint (e.g., .../api), keep it unchanged.
					if (normalizedPath && normalizedBasePath.endsWith(normalizedPath)) {
						return base.toString();
					}

					base.pathname = `${normalizedBasePath}${path}`;
					return base.toString();
				}
			}

			return new URL(path, this.baseUrl).toString();
		} catch {
			return this.baseUrl + (path.startsWith('/') ? path : '/' + path);
		}
	}

	/**
	 * Get the category mapper.
	 */
	getCategoryMapper(): CategoryMapper {
		return this.categoryMapper;
	}

	/**
	 * Get the current base URL.
	 */
	getBaseUrl(): string {
		return this.baseUrl;
	}
}

/**
 * Create a new RequestBuilder instance.
 */
export function createRequestBuilder(
	definition: CardigannDefinition,
	templateEngine: TemplateEngine,
	filterEngine: FilterEngine
): RequestBuilder {
	return new RequestBuilder(definition, templateEngine, filterEngine);
}

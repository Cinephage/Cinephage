/**
 * The request half of search-on-add: the indexer gate, the criteria, and the
 * enhanced search call.
 *
 * The movie, series, season and episode searches had each written the same
 * preflight and the same searchEnhanced options; missing and bulk repeated the
 * gate. What genuinely differs — which ids a kind carries, which profile a row
 * uses — is an argument here, not a copy.
 */

import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { evaluateIndexerSearchAvailability } from '#lib/server/indexers/search/availability.js';
import type { IndexerAvailabilityCode } from '#lib/server/indexers/search/availability.js';
import type {
	EnhancedSearchResult,
	IndexerConfig,
	SearchCriteria
} from '#lib/server/indexers/types/index.js';
import type { IndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { AUTO_GRAB_MIN_SCORE } from './search-utils.js';

export type IndexerGate =
	| { ok: true; indexerManager: IndexerManager; indexers: IndexerConfig[] }
	| { ok: false; error: string; code?: IndexerAvailabilityCode };

export interface PreflightOptions {
	searchType: 'movie' | 'tv';
	/** On-add and monitoring searches are automatic; user-triggered ones interactive. */
	searchSource: 'interactive' | 'automatic';
	scoringProfileId?: string | null;
	/** Resolved allowlist; omit to leave the search unrestricted. */
	allowedIndexerIds?: string[] | null;
	protocolFilter?: string[];
}

/**
 * Fail early when no indexer can answer this search, and hand back the manager
 * so the caller does not fetch it a second time.
 */
export async function preflightIndexerSearch(options: PreflightOptions): Promise<IndexerGate> {
	const indexerManager = await getIndexerManager();
	const indexers = await indexerManager.getIndexers();

	const availability = evaluateIndexerSearchAvailability(indexers, {
		searchType: options.searchType,
		searchSource: options.searchSource,
		allowedIndexerIds: options.allowedIndexerIds,
		scoringProfileId: options.scoringProfileId,
		protocolFilter: options.protocolFilter,
		getDefinitionCapabilities: (definitionId) =>
			indexerManager.getDefinitionCapabilities(definitionId)
	});

	if (!availability.ok) {
		return {
			ok: false,
			error: availability.message || 'No indexers are available',
			code: availability.code
		};
	}

	return { ok: true, indexerManager, indexers };
}

export interface CriteriaInput {
	searchType: 'movie' | 'tv';
	title: string;
	tmdbId: number;
	imdbId?: string | null;
	tvdbId?: number | null;
	year?: number;
	season?: number;
	episode?: number;
	/** Alternate titles; the primary title is the fallback when there are none. */
	searchTitles?: string[];
}

export function buildSearchCriteria(input: CriteriaInput): SearchCriteria {
	const { title, searchTitles, imdbId, tvdbId, ...rest } = input;
	return {
		...rest,
		query: title,
		imdbId: imdbId ?? undefined,
		tvdbId: tvdbId ?? undefined,
		searchTitles: searchTitles && searchTitles.length > 0 ? searchTitles : [title]
	};
}

/** The enriched search every on-add path runs, with the standard threshold. */
export async function searchReleases(
	indexerManager: Pick<IndexerManager, 'searchEnhanced'>,
	criteria: SearchCriteria,
	options: { searchSource: 'interactive' | 'automatic'; scoringProfileId?: string | null }
): Promise<EnhancedSearchResult> {
	return indexerManager.searchEnhanced(criteria, {
		searchSource: options.searchSource,
		enrichment: {
			scoringProfileId: options.scoringProfileId ?? undefined,
			filterRejected: true,
			minScore: AUTO_GRAB_MIN_SCORE
		}
	});
}

/**
 * Search On Add — shared types
 */

import type {
	IndexerCapabilities,
	IndexerConfig,
	SearchCriteria
} from '#lib/server/indexers/types/index.js';

export type { IndexerCapabilities, IndexerConfig, SearchCriteria };

export interface SearchForMovieParams {
	movieId: string;
	tmdbId: number;
	imdbId?: string | null;
	title: string;
	year?: number;
	scoringProfileId?: string;
	/** Bypass monitoring checks for manual user-triggered searches */
	bypassMonitoring?: boolean;
	/** Optional progress callback for real-time updates */
	onProgress?: (
		phase: string,
		message: string,
		progress?: { current: number; total: number }
	) => void;
}

export interface SearchForSeriesParams {
	seriesId: string;
	tmdbId: number;
	tvdbId?: number | null;
	imdbId?: string | null;
	title: string;
	year?: number;
	scoringProfileId?: string;
	monitorType?:
		| 'all'
		| 'future'
		| 'missing'
		| 'existing'
		| 'firstSeason'
		| 'lastSeason'
		| 'recent'
		| 'pilot'
		| 'none';
	/** When true, use interactive search source (bypasses automatic-search-disabled restriction) */
	bypassMonitoring?: boolean;
}

export interface GrabResult {
	success: boolean;
	releaseName?: string;
	error?: string;
	queueItemId?: string;
}

/** Parameters for searching a specific episode */
export interface SearchForEpisodeParams {
	episodeId: string;
	/** Bypass monitoring checks for manual user-triggered searches */
	bypassMonitoring?: boolean;
}

/** Parameters for searching a season pack */
export interface SearchForSeasonParams {
	seriesId: string;
	seasonNumber: number;
	/** Bypass monitoring checks for manual user-triggered searches */
	bypassMonitoring?: boolean;
}

export interface SearchForMissingEpisodesOptions {
	/** Bypass monitoring checks for manual user-triggered searches */
	bypassMonitoring?: boolean;
	/**
	 * Search strategy for missing episodes.
	 * - 'pack-first': complete/multi-season/single-season packs, then episodes
	 * - 'episode-only': targeted episode searches, but if an entire aired season is missing
	 *   we attempt a single-season pack grab first
	 * - 'auto': use episode-only only when RuTracker/Kinozal is the sole eligible TV indexer
	 */
	searchStrategy?: 'pack-first' | 'episode-only' | 'auto';
	/** Controls which indexers are eligible; 'automatic' for background/on-add, 'interactive' for user-triggered */
	searchSource?: 'automatic' | 'interactive';
}

/** Result for a single item in multi-search operations */
export interface AutoSearchItemResult {
	itemId: string;
	itemLabel: string;
	found: boolean;
	grabbed: boolean;
	releaseName?: string;
	error?: string;
	/** Whether this was grabbed via a season pack */
	wasPackGrab?: boolean;
}

/** Result for multi-search operations (missing, bulk) */
export interface MultiSearchResult {
	results: AutoSearchItemResult[];
	summary: {
		searched: number;
		found: number;
		grabbed: number;
		/** Number of season packs grabbed */
		seasonPacksGrabbed?: number;
		/** Number of individual episodes grabbed (not via pack) */
		individualEpisodesGrabbed?: number;
	};
	error?: string;
	/** Additional operational errors collected during fallback attempts */
	errors?: string[];
	/** Season packs that were grabbed */
	seasonPacks?: Array<{
		seasonNumber: number;
		releaseName: string;
		episodesCovered: string[];
	}>;
}

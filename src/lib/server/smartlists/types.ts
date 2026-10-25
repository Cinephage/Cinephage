/**
 * Smart Lists Types
 */

import type {
	SmartListFilters,
	SmartListRecord,
	SmartListItemRecord,
	SmartListRefreshHistoryRecord
} from '#lib/server/db/schema.js';

// Re-export schema types
export type {
	SmartListFilters,
	SmartListRecord,
	SmartListItemRecord,
	SmartListRefreshHistoryRecord
};

export type SmartListSortBy =
	| 'popularity.desc'
	| 'popularity.asc'
	| 'vote_average.desc'
	| 'vote_average.asc'
	| 'primary_release_date.desc'
	| 'primary_release_date.asc'
	| 'first_air_date.desc'
	| 'first_air_date.asc'
	| 'revenue.desc'
	| 'revenue.asc'
	| 'title.asc'
	| 'title.desc';

export type AutoAddBehavior = 'disabled' | 'add_only' | 'add_and_search';
export type SmartListMediaType = 'movie' | 'tv';
export type RefreshStatus = 'running' | 'success' | 'partial' | 'failed';
export type ListSourceType = 'tmdb-discover' | 'external-json' | 'trakt-list' | 'custom-manual';

export interface CreateSmartListInput {
	name: string;
	description?: string;
	mediaType: SmartListMediaType;
	filters: SmartListFilters;
	sortBy?: SmartListSortBy;
	itemLimit?: number;
	excludeInLibrary?: boolean;
	showUpgradeableOnly?: boolean;
	excludedTmdbIds?: number[];
	scoringProfileId?: string;
	autoAddBehavior?: AutoAddBehavior;
	rootFolderId?: string;
	autoAddMonitored?: boolean;
	minimumAvailability?: string;
	wantsSubtitles?: boolean;
	languageProfileId?: string;
	refreshIntervalHours?: number;
	enabled?: boolean;
	listSourceType?: ListSourceType;
	externalSourceConfig?: {
		url?: string;
		headers?: Record<string, unknown>;
		listId?: string;
		username?: string;
	};
	presetId?: string;
	presetProvider?: string;
	presetSettings?: Record<string, unknown>;
}

export interface UpdateSmartListInput {
	name?: string;
	description?: string | null;
	filters?: SmartListFilters;
	sortBy?: SmartListSortBy;
	itemLimit?: number;
	excludeInLibrary?: boolean;
	showUpgradeableOnly?: boolean;
	excludedTmdbIds?: number[];
	scoringProfileId?: string | null;
	autoAddBehavior?: AutoAddBehavior;
	rootFolderId?: string | null;
	autoAddMonitored?: boolean;
	minimumAvailability?: string;
	wantsSubtitles?: boolean;
	languageProfileId?: string | null;
	refreshIntervalHours?: number;
	enabled?: boolean;
	listSourceType?: ListSourceType;
	externalSourceConfig?: {
		url?: string;
		headers?: Record<string, unknown>;
		listId?: string;
		username?: string;
	};
	presetId?: string;
	presetProvider?: string;
	presetSettings?: Record<string, unknown>;
}

export interface RefreshResult {
	smartListId: string;
	status: RefreshStatus;
	itemsFound: number;
	itemsNew: number;
	itemsRemoved: number;
	itemsAutoAdded: number;
	itemsFailed: number;
	failureDetails?: Array<{ tmdbId: number; title: string; error: string }>;
	durationMs: number;
	errorMessage?: string;
}

export interface ItemQueryOptions {
	page?: number;
	limit?: number;
	inLibrary?: boolean | null;
	isExcluded?: boolean;
	includeExcluded?: boolean;
	query?: string;
}

export interface BulkAddResult {
	added: number;
	failed: number;
	alreadyInLibrary: number;
	errors: Array<{ tmdbId: number; title: string; error: string }>;
}

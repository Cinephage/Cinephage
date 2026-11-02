/**
 * Constants and types for the Activity page.
 *
 * Extracted from +page.svelte so they can be imported by utility functions,
 * composables, and sub-components without pulling in Svelte-specific code.
 */

import type { ActivityFilters as FiltersType } from '#lib/types/activity.js';

// ── Tab type ──────────────────────────────────────────────────────────
export type ActivityTab = 'active' | 'history' | 'unmatched';

// ── Confirmation / bulk action types ──────────────────────────────────
export type HistoryConfirmAction = 'purge_older_than_retention' | 'purge_all' | 'delete_selected';
export type ActiveBulkAction = 'pause' | 'resume' | 'cancel' | 'retry_failed' | 'remove_failed';

// ── Tab-specific status options ───────────────────────────────────────
export const ACTIVE_TAB_STATUSES: NonNullable<FiltersType['status']>[] = [
	'all',
	'downloading',
	'seeding',
	'paused'
];

export const HISTORY_TAB_STATUSES: NonNullable<FiltersType['status']>[] = [
	'all',
	'success',
	'failed',
	'search_error',
	'removed',
	'rejected',
	'no_results'
];

// ── Default filter shape ──────────────────────────────────────────────
export const BASE_FILTERS: FiltersType = {
	status: 'all',
	mediaType: 'all',
	protocol: 'all'
};

// ── Queue stats ───────────────────────────────────────────────────────
export interface QueueCardStats {
	totalCount: number;
	downloadingCount: number;
	seedingCount: number;
	pausedCount: number;
	failedCount: number;
}

export type QueueCardStatusFilter = Extract<
	NonNullable<FiltersType['status']>,
	'all' | 'downloading' | 'seeding' | 'paused' | 'failed'
>;

export const ACTIVITY_REFRESH_MIN_INTERVAL_MS = 10000;

/**
 * Shared types for the storage domain.
 * Used by ReconciliationService (Phase 2) and InsightsService (Phase 3).
 */

import type { storageItems, storageItemServerLinks } from '#lib/server/db/schema.js';

/**
 * A storage_items row joined with its server links (if any).
 * This is the in-memory shape the insight rules consume.
 */
export type StorageItemJoined = typeof storageItems.$inferSelect & {
	serverLinks?: Array<typeof storageItemServerLinks.$inferSelect>;
};

/**
 * The logical key used to dedupe storage_items rows.
 * Matches the unique index `idx_storage_items_logical`.
 */
export interface LogicalKey {
	itemType: 'movie' | 'episode' | 'series' | 'season';
	tmdbId: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
}

/**
 * Result of a reconciliation run. Returned by ReconciliationService.reconcile()
 * for logging and (future) UI display.
 */
export interface ReconcileResult {
	itemsUpserted: number;
	itemsInserted: number;
	itemsUpdated: number;
	itemsDeleted: number;
	linksUpserted: number;
	errorCount: number;
	durationMs: number;
	skipped: boolean;
}

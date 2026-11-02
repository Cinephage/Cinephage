/**
 * Insight engine types. Each rule produces InsightFinding[]; InsightsService
 * upserts them into the storage_insights table.
 */

import type { db } from '#lib/server/db/index.js';

export type InsightType =
	| 'orphaned-files'
	| 'missing-from-media-server'
	| 'untracked-by-cinephage'
	| 'unplayed'
	| 'duplicate-items'
	| 'quality-below-cutoff'
	| 'broken-paths'
	| 'health-issues'
	| 'filename-duplicates'
	| 'redundant-quality-tiers';

export type InsightSeverity = 'info' | 'warning' | 'critical';
export type InsightScope = 'global' | 'library' | 'root_folder' | 'item';

/**
 * A single finding produced by a rule's evaluate() method.
 * One finding maps to one storage_insights row (keyed by type+scope+scopeId).
 */
export interface InsightFinding {
	type: InsightType;
	severity: InsightSeverity;
	scope: InsightScope;
	scopeId?: string | null;
	title: string;
	summary: string;
	details?: Record<string, unknown>;
	reclaimableBytes?: number;
	itemCount: number;
}

/**
 * Context passed to each rule's evaluate() method.
 * Rules receive the db handle and query what they need (lazy, self-contained).
 */
export interface RuleContext {
	db: typeof db;
	now: string; // ISO timestamp for consistency across rules
}

/**
 * Interface every insight rule implements.
 * One class per file, barrel-exported from rules/index.ts.
 */
export interface StorageInsightRule {
	readonly type: InsightType;
	evaluate(ctx: RuleContext): Promise<InsightFinding[]>;
}

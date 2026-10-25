import type { db } from '#lib/server/db/index.js';
import type { StorageInsightRecord } from '#lib/server/db/schema.js';

export type InsightItemKind = 'movie' | 'series' | 'episode' | 'file' | 'folder';

export interface InsightItemBadge {
	label: string;
	tone: 'info' | 'warn' | 'critical';
}

export interface InsightItem {
	id: string;
	kind: InsightItemKind;
	title: string;
	subtitle?: string;
	sizeBytes?: number;
	badges?: InsightItemBadge[];
	href?: string;
	meta?: Record<string, unknown>;
}

export interface InsightItemResolverContext {
	db: typeof db;
	insight: StorageInsightRecord;
	page: number;
	limit: number;
}

export interface InsightItemResolverResult {
	items: InsightItem[];
	total: number;
}

export type InsightItemResolver = (
	ctx: InsightItemResolverContext
) => Promise<InsightItemResolverResult>;

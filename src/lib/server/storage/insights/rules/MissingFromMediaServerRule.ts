import { and, count, eq, notInArray } from 'drizzle-orm';
import { mediaBrowserServers, storageItems } from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';

/**
 * Items in storage_items with sourceSystem='local' — present in Cinephage's
 * library but not tracked by any media server. Suppressed when zero media
 * servers are configured (can't be "missing" from a server the user doesn't have).
 */
export class MissingFromMediaServerRule implements StorageInsightRule {
	readonly type = 'missing-from-media-server' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		const serverCount =
			ctx.db
				.select({ count: count() })
				.from(mediaBrowserServers)
				.where(eq(mediaBrowserServers.enabled, true))
				.get()?.count ?? 0;

		if (serverCount === 0) return [];

		const localOnlyRows = ctx.db
			.select({ tmdbId: storageItems.tmdbId, itemType: storageItems.itemType })
			.from(storageItems)
			.where(
				and(
					eq(storageItems.sourceSystem, 'local'),
					notInArray(storageItems.itemType, ['series', 'season'])
				)
			)
			.all();

		if (localOnlyRows.length === 0) return [];

		// storage_items tracks TV content per-episode, so the raw row count
		// reads as a much bigger number than the distinct shows/movies it
		// actually affects. Break it down to match the grouped detail list
		// (missingFromMediaServerResolver).
		const movieTmdbIds = new Set<number>();
		const seriesTmdbIds = new Set<number>();
		for (const row of localOnlyRows) {
			if (row.tmdbId == null) continue;
			if (row.itemType === 'movie') movieTmdbIds.add(row.tmdbId);
			else seriesTmdbIds.add(row.tmdbId);
		}
		const breakdownParts: string[] = [];
		if (movieTmdbIds.size > 0) {
			breakdownParts.push(`${movieTmdbIds.size} Movie${movieTmdbIds.size === 1 ? '' : 's'}`);
		}
		if (seriesTmdbIds.size > 0) {
			breakdownParts.push(`${seriesTmdbIds.size} Series`);
		}
		const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : '';

		const localOnlyCount = localOnlyRows.length;

		return [
			{
				type: this.type,
				severity: 'info',
				scope: 'global',
				title: `Items missing from your media server`,
				summary: `${localOnlyCount} item${localOnlyCount === 1 ? '' : 's'}${breakdown} ${localOnlyCount === 1 ? 'is' : 'are'} in your Cinephage library but not tracked by any media server. Sync your media server library to fix.`,
				itemCount: localOnlyCount
			}
		];
	}
}

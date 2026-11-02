import { and, eq, notInArray } from 'drizzle-orm';
import { storageItems } from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';
import { untrackedGroupKey } from '../untracked-grouping.js';

/**
 * Items in storage_items with sourceSystem='server' — present on a media
 * server but Cinephage has no local file for them. Excludes series/season
 * item types because those are organizational containers in Jellyfin/Emby —
 * if Cinephage tracks the episodes, the series IS tracked, just at a
 * different granularity.
 */
export class UntrackedByCinephageRule implements StorageInsightRule {
	readonly type = 'untracked-by-cinephage' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		const serverOnlyRows = ctx.db
			.select({
				id: storageItems.id,
				tmdbId: storageItems.tmdbId,
				itemType: storageItems.itemType,
				seriesName: storageItems.seriesName
			})
			.from(storageItems)
			.where(
				and(
					eq(storageItems.sourceSystem, 'server'),
					notInArray(storageItems.itemType, ['series', 'season'])
				)
			)
			.all();

		if (serverOnlyRows.length === 0) return [];

		// storage_items tracks TV content per-episode, so the raw row count
		// reads as a much bigger number than the distinct shows/movies it
		// actually affects. Break it down to match the grouped detail list
		// (untrackedByCinephageResolver) - same grouping key, so every row
		// (including ones without a resolved tmdbId) counts toward the
		// breakdown exactly once per distinct group.
		const movieGroups = new Set<string>();
		const seriesGroups = new Set<string>();
		for (const row of serverOnlyRows) {
			const key = untrackedGroupKey(row);
			if (row.itemType === 'movie') movieGroups.add(key);
			else seriesGroups.add(key);
		}
		const breakdownParts: string[] = [];
		if (movieGroups.size > 0) {
			breakdownParts.push(`${movieGroups.size} Movie${movieGroups.size === 1 ? '' : 's'}`);
		}
		if (seriesGroups.size > 0) {
			breakdownParts.push(`${seriesGroups.size} Series`);
		}
		const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : '';

		const serverOnlyCount = serverOnlyRows.length;

		return [
			{
				type: this.type,
				severity: 'info',
				scope: 'global',
				title: `Items on media server not tracked by Cinephage`,
				summary: `${serverOnlyCount} item${serverOnlyCount === 1 ? '' : 's'}${breakdown} ${serverOnlyCount === 1 ? 'is' : 'are'} on your media server${serverOnlyCount === 1 ? '' : 's'} but Cinephage has no local file for ${serverOnlyCount === 1 ? 'it' : 'them'}.`,
				itemCount: serverOnlyCount
			}
		];
	}
}

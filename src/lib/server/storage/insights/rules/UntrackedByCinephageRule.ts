import { and, eq, notInArray } from 'drizzle-orm';
import { storageItems } from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';

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
			.select({ tmdbId: storageItems.tmdbId, itemType: storageItems.itemType })
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
		// (untrackedByCinephageResolver).
		const movieTmdbIds = new Set<number>();
		const seriesTmdbIds = new Set<number>();
		for (const row of serverOnlyRows) {
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

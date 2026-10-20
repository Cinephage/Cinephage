import { movies, series } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import type { InsightItemResolver } from './types.js';

export const brokenPathsResolver: InsightItemResolver = async ({ db, insight, page, limit }) => {
	const rawDetails = insight.detailsJson ? JSON.parse(insight.detailsJson) : null;
	if (!rawDetails?.items || !Array.isArray(rawDetails.items)) {
		return { items: [], total: 0 };
	}
	type Item = {
		storageId: string;
		title: string;
		tmdbId: number | null;
		itemType: 'movie' | 'episode';
	};
	const items: Item[] = rawDetails.items;
	const total = items.length;
	const sliceStart = (page - 1) * limit;
	const sliced = items.slice(sliceStart, sliceStart + limit);
	// Movie and series tmdbIds are independent namespaces - a movie and an
	// unrelated show can share the same numeric id, so the href must be
	// looked up in the map matching this item's own itemType, never by
	// probing one map then falling back to the other.
	const movieTmdbIds = sliced
		.filter((i) => i.itemType === 'movie' && i.tmdbId !== null)
		.map((i) => i.tmdbId!);
	const seriesTmdbIds = sliced
		.filter((i) => i.itemType === 'episode' && i.tmdbId !== null)
		.map((i) => i.tmdbId!);
	const movieMap = new Map<number, string>();
	const seriesMap = new Map<number, string>();
	if (movieTmdbIds.length > 0) {
		const movieRows = db
			.select({ id: movies.id, tmdbId: movies.tmdbId })
			.from(movies)
			.where(inArray(movies.tmdbId, movieTmdbIds))
			.all();
		for (const r of movieRows) movieMap.set(r.tmdbId, r.id);
	}
	if (seriesTmdbIds.length > 0) {
		const seriesRows = db
			.select({ id: series.id, tmdbId: series.tmdbId })
			.from(series)
			.where(inArray(series.tmdbId, seriesTmdbIds))
			.all();
		for (const r of seriesRows) seriesMap.set(r.tmdbId, r.id);
	}
	return {
		items: sliced.map((item) => ({
			id: `bp-${item.storageId}`,
			kind: item.itemType,
			title: item.title,
			subtitle: `Storage ID: ${item.storageId}`,
			badges: [{ label: 'File missing', tone: 'critical' as const }],
			href:
				item.tmdbId === null
					? undefined
					: item.itemType === 'movie'
						? movieMap.has(item.tmdbId)
							? `/library/movie/${movieMap.get(item.tmdbId)}`
							: undefined
						: seriesMap.has(item.tmdbId)
							? `/library/tv/${seriesMap.get(item.tmdbId)}`
							: undefined
		})),
		total
	};
};

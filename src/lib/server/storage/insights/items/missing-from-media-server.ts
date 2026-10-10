import { storageItems, movies, series } from '#lib/server/db/schema.js';
import { eq, notInArray, and, inArray } from 'drizzle-orm';
import type { InsightItemResolver } from './types.js';

export const missingFromMediaServerResolver: InsightItemResolver = async ({ db, page, limit }) => {
	const rows = db
		.select({
			id: storageItems.id,
			title: storageItems.title,
			tmdbId: storageItems.tmdbId,
			itemType: storageItems.itemType,
			seriesName: storageItems.seriesName
		})
		.from(storageItems)
		.where(
			and(
				eq(storageItems.sourceSystem, 'local'),
				notInArray(storageItems.itemType, ['series', 'season'])
			)
		)
		.all();

	if (rows.length === 0) return { items: [], total: 0 };

	// storage_items tracks TV content per-episode, so group by the parent
	// movie/series before paginating - otherwise a show missing many
	// episodes from the media server shows once per episode.
	type Group = {
		key: string;
		title: string;
		isMovie: boolean;
		tmdbId: number | null;
		count: number;
	};
	const groups = new Map<string, Group>();
	for (const row of rows) {
		const isMovie = row.itemType === 'movie';
		const key = row.tmdbId != null ? `${isMovie ? 'm' : 's'}-${row.tmdbId}` : `row-${row.id}`;
		const existing = groups.get(key);
		if (existing) {
			existing.count++;
		} else {
			groups.set(key, {
				key,
				title: isMovie ? row.title : (row.seriesName ?? row.title),
				isMovie,
				tmdbId: row.tmdbId,
				count: 1
			});
		}
	}

	const groupedList = [...groups.values()];
	const total = groupedList.length;
	const sliceStart = (page - 1) * limit;
	const sliced = groupedList.slice(sliceStart, sliceStart + limit);

	const movieTmdbIds = sliced.filter((g) => g.isMovie && g.tmdbId != null).map((g) => g.tmdbId!);
	const seriesTmdbIds = sliced.filter((g) => !g.isMovie && g.tmdbId != null).map((g) => g.tmdbId!);

	const movieMap = new Map<number, string>();
	const seriesMap = new Map<number, string>();
	if (movieTmdbIds.length > 0) {
		const mr = db
			.select({ id: movies.id, tmdbId: movies.tmdbId })
			.from(movies)
			.where(inArray(movies.tmdbId, movieTmdbIds))
			.all();
		for (const r of mr) movieMap.set(r.tmdbId, r.id);
	}
	if (seriesTmdbIds.length > 0) {
		const sr = db
			.select({ id: series.id, tmdbId: series.tmdbId })
			.from(series)
			.where(inArray(series.tmdbId, seriesTmdbIds))
			.all();
		for (const r of sr) seriesMap.set(r.tmdbId, r.id);
	}

	return {
		items: sliced.map((g) => ({
			id: `mm-${g.key}`,
			kind: (g.isMovie ? 'movie' : 'series') as 'movie' | 'series',
			title: g.title,
			badges: [
				{
					label: !g.isMovie && g.count > 1 ? `${g.count} episodes missing` : 'Missing from server',
					tone: 'info' as const
				}
			],
			href: g.tmdbId
				? g.isMovie
					? movieMap.has(g.tmdbId)
						? `/library/movie/${movieMap.get(g.tmdbId)}`
						: undefined
					: seriesMap.has(g.tmdbId)
						? `/library/tv/${seriesMap.get(g.tmdbId)}`
						: undefined
				: undefined
		})),
		total
	};
};

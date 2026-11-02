import { movies } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import type { InsightItemResolver } from './types.js';

export const duplicateItemsResolver: InsightItemResolver = async ({ db, insight, page, limit }) => {
	const rawDetails = insight.detailsJson ? JSON.parse(insight.detailsJson) : null;
	if (!rawDetails?.items || !Array.isArray(rawDetails.items)) {
		return { items: [], total: 0 };
	}

	const items: Array<{ tmdbId: number; title: string; fileCount: number }> = rawDetails.items;
	const total = items.length;
	const sliceStart = (page - 1) * limit;
	const sliced = items.slice(sliceStart, sliceStart + limit);

	const tmdbIds = sliced.map((i) => i.tmdbId).filter(Boolean);
	const movieMap = new Map<number, string>();
	if (tmdbIds.length > 0) {
		const rows = db
			.select({ id: movies.id, tmdbId: movies.tmdbId })
			.from(movies)
			.where(inArray(movies.tmdbId, tmdbIds))
			.all();
		for (const row of rows) {
			movieMap.set(row.tmdbId, row.id);
		}
	}

	return {
		items: sliced.map((item) => ({
			id: `dup-${item.tmdbId}`,
			kind: 'movie' as const,
			title: item.title,
			subtitle: `${item.fileCount} files`,
			badges: [{ label: `${item.fileCount}x files`, tone: 'warn' as const }],
			href: movieMap.has(item.tmdbId) ? `/library/movie/${movieMap.get(item.tmdbId)}` : undefined
		})),
		total
	};
};

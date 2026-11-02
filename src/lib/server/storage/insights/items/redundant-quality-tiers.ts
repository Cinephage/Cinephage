import { movies } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import type { InsightItemResolver } from './types.js';

export const redundantQualityTiersResolver: InsightItemResolver = async ({
	db,
	insight,
	page,
	limit
}) => {
	const rawDetails = insight.detailsJson ? JSON.parse(insight.detailsJson) : null;
	if (!Array.isArray(rawDetails?.items) || rawDetails.items.length === 0) {
		return { items: [], total: 0 };
	}

	type DetailItem = { tmdbId: number | null; title: string | null; redundantCount: number };
	const allItems: DetailItem[] = rawDetails.items;
	const total = allItems.length;
	const sliced = allItems.slice((page - 1) * limit, (page - 1) * limit + limit);

	const tmdbIds = sliced.filter((i) => i.tmdbId != null).map((i) => i.tmdbId!);
	const movieMap = new Map<number, string>();
	if (tmdbIds.length > 0) {
		const rows = db
			.select({ id: movies.id, tmdbId: movies.tmdbId })
			.from(movies)
			.where(inArray(movies.tmdbId, tmdbIds))
			.all();
		for (const r of rows) if (r.tmdbId != null) movieMap.set(r.tmdbId, r.id);
	}

	return {
		items: sliced.map((item, idx) => ({
			id: `rqt-${page}-${idx}`,
			kind: 'movie' as const,
			title: item.title ?? 'Unknown',
			subtitle: `${item.redundantCount} redundant file${item.redundantCount === 1 ? '' : 's'}`,
			badges: [{ label: 'Redundant', tone: 'info' as const }],
			href:
				item.tmdbId != null && movieMap.has(item.tmdbId)
					? `/library/movie/${movieMap.get(item.tmdbId)}`
					: undefined
		})),
		total
	};
};

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { downloadHistory, movies, series } from '#lib/server/db/schema.js';
import { eq, desc, and, isNotNull, isNull, inArray } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QueueHistoryApi', logDomain: 'downloads' });

/**
 * GET - Get download history with optional filtering
 *
 * Query params:
 * - status: Filter by status ('imported', 'failed', 'rejected', 'removed', 'all')
 * - mediaType: Filter by media type ('movie', 'tv', 'all')
 * - limit: Max number of results (default 50)
 * - offset: Pagination offset (default 0)
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const statusParam = url.searchParams.get('status');
		const mediaType = url.searchParams.get('mediaType');
		const limitParam = url.searchParams.get('limit');
		const offsetParam = url.searchParams.get('offset');

		const limit = limitParam ? parseInt(limitParam, 10) : 50;
		const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

		// Build where conditions
		const conditions = [];

		// Status filter
		if (statusParam && statusParam !== 'all') {
			conditions.push(eq(downloadHistory.status, statusParam));
		}

		// Media type filter
		if (mediaType === 'movie') {
			conditions.push(and(isNotNull(downloadHistory.movieId), isNull(downloadHistory.seriesId)));
		} else if (mediaType === 'tv') {
			conditions.push(and(isNotNull(downloadHistory.seriesId), isNull(downloadHistory.movieId)));
		}

		// Get history items with conditions
		const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

		const historyItems = await db
			.select()
			.from(downloadHistory)
			.where(whereClause)
			.orderBy(desc(downloadHistory.createdAt))
			.limit(limit)
			.offset(offset)
			.all();

		// Batch fetch related media
		const movieIds = [...new Set(historyItems.filter((h) => h.movieId).map((h) => h.movieId!))];
		const seriesIds = [...new Set(historyItems.filter((h) => h.seriesId).map((h) => h.seriesId!))];

		const moviesData =
			movieIds.length > 0
				? await db
						.select({ id: movies.id, title: movies.title, year: movies.year })
						.from(movies)
						.where(inArray(movies.id, movieIds))
						.all()
				: [];

		const seriesData =
			seriesIds.length > 0
				? await db
						.select({ id: series.id, title: series.title, year: series.year })
						.from(series)
						.where(inArray(series.id, seriesIds))
						.all()
				: [];

		// Create lookup maps
		const movieMap = new Map(moviesData.map((m) => [m.id, m]));
		const seriesMap = new Map(seriesData.map((s) => [s.id, s]));

		// Enrich history items with media info
		const enrichedItems = historyItems.map((item) => {
			let media = null;
			if (item.movieId && movieMap.has(item.movieId)) {
				media = { type: 'movie' as const, ...movieMap.get(item.movieId) };
			} else if (item.seriesId && seriesMap.has(item.seriesId)) {
				media = { type: 'series' as const, ...seriesMap.get(item.seriesId) };
			}
			return { ...item, media };
		});

		// Get total count for pagination
		const totalCount = await db
			.select({ count: downloadHistory.id })
			.from(downloadHistory)
			.where(whereClause)
			.all();

		// Calculate stats
		const stats = {
			total: totalCount.length,
			imported: historyItems.filter((h) => h.status === 'imported').length,
			streaming: historyItems.filter((h) => h.status === 'streaming').length,
			failed: historyItems.filter((h) => h.status === 'failed').length,
			rejected: historyItems.filter((h) => h.status === 'rejected').length,
			removed: historyItems.filter((h) => h.status === 'removed').length
		};

		return Response.json({
			items: enrichedItems,
			pagination: {
				limit,
				offset,
				total: totalCount.length,
				hasMore: offset + historyItems.length < totalCount.length
			},
			stats
		});
	} catch (err) {
		logger.error('Error fetching history', err instanceof Error ? err : undefined);
		return Response.json({ error: 'Failed to fetch history' }, { status: 500 });
	}
};

/**
 * DELETE - Clear history (optionally by status or all)
 */
export const DELETE: RequestHandler = async ({ url }) => {
	try {
		const status = url.searchParams.get('status');
		const confirm = url.searchParams.get('confirm');

		// Require confirmation
		if (confirm !== 'true') {
			return Response.json(
				{ error: 'Confirmation required. Add ?confirm=true to delete history.' },
				{ status: 400 }
			);
		}

		if (status && status !== 'all') {
			// Delete specific status
			await db.delete(downloadHistory).where(eq(downloadHistory.status, status));

			return Response.json({
				success: true,
				message: `Cleared history with status: ${status}`
			});
		}

		// Delete all
		await db.delete(downloadHistory);

		return Response.json({
			success: true,
			message: 'Cleared all download history'
		});
	} catch (err) {
		logger.error('Error clearing history', err instanceof Error ? err : undefined);
		return Response.json({ error: 'Failed to clear history' }, { status: 500 });
	}
};

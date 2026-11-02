import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { subtitleHistory } from '#lib/server/db/schema.js';
import { eq, desc, and, gte, lte } from 'drizzle-orm';

/**
 * GET /api/subtitles/history
 * Get subtitle history with filtering options.
 */
export const GET: RequestHandler = async ({ url }) => {
	const movieId = url.searchParams.get('movieId');
	const episodeId = url.searchParams.get('episodeId');
	const action = url.searchParams.get('action');
	const providerId = url.searchParams.get('providerId');
	const startDate = url.searchParams.get('startDate');
	const endDate = url.searchParams.get('endDate');
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
	const offset = parseInt(url.searchParams.get('offset') || '0');

	// Build query conditions
	const conditions = [];

	if (movieId) {
		conditions.push(eq(subtitleHistory.movieId, movieId));
	}

	if (episodeId) {
		conditions.push(eq(subtitleHistory.episodeId, episodeId));
	}

	if (action) {
		conditions.push(
			eq(
				subtitleHistory.action,
				action as 'downloaded' | 'deleted' | 'synced' | 'upgraded' | 'manual_upload' | 'discovered'
			)
		);
	}

	if (providerId) {
		conditions.push(eq(subtitleHistory.providerId, providerId));
	}

	if (startDate) {
		conditions.push(gte(subtitleHistory.createdAt, startDate));
	}

	if (endDate) {
		conditions.push(lte(subtitleHistory.createdAt, endDate));
	}

	// Execute query with join to get provider name
	let query = db
		.select({
			id: subtitleHistory.id,
			movieId: subtitleHistory.movieId,
			episodeId: subtitleHistory.episodeId,
			action: subtitleHistory.action,
			language: subtitleHistory.language,
			providerId: subtitleHistory.providerId,
			providerName: subtitleHistory.providerName,
			providerSubtitleId: subtitleHistory.providerSubtitleId,
			matchScore: subtitleHistory.matchScore,
			wasHashMatch: subtitleHistory.wasHashMatch,
			replacedSubtitleId: subtitleHistory.replacedSubtitleId,
			errorMessage: subtitleHistory.errorMessage,
			createdAt: subtitleHistory.createdAt
		})
		.from(subtitleHistory)
		.orderBy(desc(subtitleHistory.createdAt));

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as typeof query;
	}

	const results = await query.limit(limit).offset(offset);

	// Get total count for pagination
	const allResults =
		conditions.length > 0
			? await db
					.select({ id: subtitleHistory.id })
					.from(subtitleHistory)
					.where(and(...conditions))
			: await db.select({ id: subtitleHistory.id }).from(subtitleHistory);

	const total = allResults.length;

	return Response.json({
		items: results,
		total,
		limit,
		offset,
		hasMore: offset + results.length < total
	});
};

/**
 * DELETE /api/subtitles/history
 * Clear subtitle history (optionally filtered).
 */
export const DELETE: RequestHandler = async ({ url }) => {
	const movieId = url.searchParams.get('movieId');
	const episodeId = url.searchParams.get('episodeId');
	const olderThan = url.searchParams.get('olderThan'); // ISO date string

	const conditions = [];

	if (movieId) {
		conditions.push(eq(subtitleHistory.movieId, movieId));
	}

	if (episodeId) {
		conditions.push(eq(subtitleHistory.episodeId, episodeId));
	}

	if (olderThan) {
		conditions.push(lte(subtitleHistory.createdAt, olderThan));
	}

	if (conditions.length === 0) {
		return Response.json({ error: 'At least one filter is required for safety' }, { status: 400 });
	}

	await db.delete(subtitleHistory).where(and(...conditions));

	return Response.json({ success: true });
};

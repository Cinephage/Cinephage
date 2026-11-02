import type { RequestHandler } from './$types';
import { subtitleBlacklistSchema } from '#lib/validation/schemas.js';
import { db } from '#lib/server/db/index.js';
import { subtitleBlacklist, subtitles } from '#lib/server/db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { parseBody } from '#lib/server/api/validate.js';

/**
 * GET /api/subtitles/blacklist
 * List all blacklisted subtitles.
 */
export const GET: RequestHandler = async ({ url }) => {
	const movieId = url.searchParams.get('movieId');
	const episodeId = url.searchParams.get('episodeId');
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
	const offset = parseInt(url.searchParams.get('offset') || '0');

	let query = db.select().from(subtitleBlacklist).orderBy(desc(subtitleBlacklist.createdAt));

	if (movieId) {
		query = query.where(eq(subtitleBlacklist.movieId, movieId)) as typeof query;
	} else if (episodeId) {
		query = query.where(eq(subtitleBlacklist.episodeId, episodeId)) as typeof query;
	}

	const results = await query.limit(limit).offset(offset);

	return Response.json({
		items: results,
		total: results.length,
		limit,
		offset
	});
};

/**
 * POST /api/subtitles/blacklist
 * Add a subtitle to the blacklist.
 */
export const POST: RequestHandler = async ({ request }) => {
	const validated = await parseBody(request, subtitleBlacklistSchema);

	// Check if already blacklisted
	const existing = await db.query.subtitleBlacklist.findFirst({
		where: and(
			eq(subtitleBlacklist.providerId, validated.providerId),
			eq(subtitleBlacklist.providerSubtitleId, validated.providerSubtitleId)
		)
	});

	if (existing) {
		return Response.json({ error: 'Subtitle is already blacklisted' }, { status: 409 });
	}

	// If subtitleId is provided, get additional info
	let language: string | undefined;
	if (validated.subtitleId) {
		const subtitle = await db.query.subtitles.findFirst({
			where: eq(subtitles.id, validated.subtitleId)
		});
		if (subtitle) {
			language = subtitle.language;
		}
	}

	const [created] = await db
		.insert(subtitleBlacklist)
		.values({
			id: randomUUID(),
			providerId: validated.providerId,
			providerSubtitleId: validated.providerSubtitleId,
			movieId: validated.movieId ?? null,
			episodeId: validated.episodeId ?? null,
			language: language ?? 'unknown',
			reason: validated.reason,
			createdAt: new Date().toISOString()
		})
		.returning();

	return Response.json({ success: true, blacklist: created });
};

/**
 * DELETE /api/subtitles/blacklist
 * Remove a subtitle from the blacklist.
 */
export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id');
	const providerId = url.searchParams.get('providerId');
	const providerSubtitleId = url.searchParams.get('providerSubtitleId');

	if (id) {
		await db.delete(subtitleBlacklist).where(eq(subtitleBlacklist.id, id));
		return Response.json({ success: true });
	}

	if (providerId && providerSubtitleId) {
		await db
			.delete(subtitleBlacklist)
			.where(
				and(
					eq(subtitleBlacklist.providerId, providerId),
					eq(subtitleBlacklist.providerSubtitleId, providerSubtitleId)
				)
			);
		return Response.json({ success: true });
	}

	return Response.json(
		{ error: 'Either id or providerId+providerSubtitleId is required' },
		{ status: 400 }
	);
};

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { subtitles, movies, episodes } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * GET /api/subtitles/media?movieId=xxx or ?episodeId=xxx
 * Get all subtitles for a specific movie or episode.
 */
export const GET: RequestHandler = async ({ url }) => {
	const movieId = url.searchParams.get('movieId');
	const episodeId = url.searchParams.get('episodeId');

	if (!movieId && !episodeId) {
		return Response.json(
			{ error: 'Either movieId or episodeId query parameter is required' },
			{ status: 400 }
		);
	}

	try {
		if (movieId) {
			// Verify movie exists
			const movie = await db.query.movies.findFirst({
				where: eq(movies.id, movieId)
			});

			if (!movie) {
				return Response.json({ error: 'Movie not found' }, { status: 404 });
			}

			// Get all subtitles for this movie
			const movieSubtitles = await db
				.select({
					id: subtitles.id,
					language: subtitles.language,
					relativePath: subtitles.relativePath,
					isForced: subtitles.isForced,
					isHearingImpaired: subtitles.isHearingImpaired,
					format: subtitles.format,
					matchScore: subtitles.matchScore,
					isHashMatch: subtitles.isHashMatch,
					providerId: subtitles.providerId,
					wasSynced: subtitles.wasSynced,
					syncOffset: subtitles.syncOffset,
					dateAdded: subtitles.dateAdded
				})
				.from(subtitles)
				.where(eq(subtitles.movieId, movieId));

			return Response.json({
				success: true,
				subtitles: movieSubtitles
			});
		}

		if (episodeId) {
			// Verify episode exists
			const episode = await db.query.episodes.findFirst({
				where: eq(episodes.id, episodeId)
			});

			if (!episode) {
				return Response.json({ error: 'Episode not found' }, { status: 404 });
			}

			// Get all subtitles for this episode
			const episodeSubtitles = await db
				.select({
					id: subtitles.id,
					language: subtitles.language,
					relativePath: subtitles.relativePath,
					isForced: subtitles.isForced,
					isHearingImpaired: subtitles.isHearingImpaired,
					format: subtitles.format,
					matchScore: subtitles.matchScore,
					isHashMatch: subtitles.isHashMatch,
					providerId: subtitles.providerId,
					wasSynced: subtitles.wasSynced,
					syncOffset: subtitles.syncOffset,
					dateAdded: subtitles.dateAdded
				})
				.from(subtitles)
				.where(eq(subtitles.episodeId, episodeId));

			return Response.json({
				success: true,
				subtitles: episodeSubtitles
			});
		}

		return Response.json({ error: 'Either movieId or episodeId is required' }, { status: 400 });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { movies, episodes, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { subtitleRequirementSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';
import { parseBody, assertFound } from '#lib/server/api/validate.js';
import {
	autoSearchEpisode,
	autoSearchMovie,
	summarizeAutoSearchReason,
	type AutoSearchItemResult,
	type AutoSearchReason
} from '#lib/server/subtitles/auto-search.js';

const logger = createChildLogger({ module: 'SubtitleAutoSearchApi', logDomain: 'subtitles' });

const autoSearchSchema = z
	.object({
		movieId: z.string().uuid().optional(),
		episodeId: z.string().uuid().optional(),
		languages: z.array(z.string()).optional(),
		/** Target a single requirement row ("Search now" from details pages). */
		requirement: subtitleRequirementSchema.optional()
	})
	.refine((data) => data.movieId || data.episodeId, {
		message: 'Either movieId or episodeId is required'
	});

const REASON_MESSAGES: Record<AutoSearchReason | 'satisfied', string> = {
	no_file: 'Media has no file on disk',
	not_monitored: 'Media is not monitored',
	opted_out: 'Subtitles are disabled for this media',
	no_profile: 'No language profile is assigned or set as default',
	no_results: 'No subtitle results found from providers',
	below_threshold: 'Results were found but none satisfied the requirement at the minimum score',
	downloaded: 'Subtitle downloaded',
	error: 'Subtitle search or download failed',
	satisfied: 'No missing subtitles'
};

/** Build the single-item JSON response from an orchestration result. */
function toResponse(result: AutoSearchItemResult) {
	const reason = summarizeAutoSearchReason(result);
	const rejected = result.outcomes.find((outcome) => outcome.reason === 'below_threshold');
	const downloaded = result.outcomes.find((outcome) => outcome.reason === 'downloaded');

	return {
		success: result.downloaded > 0,
		searched: result.searched,
		downloaded: result.downloaded > 0,
		reason,
		message: REASON_MESSAGES[reason],
		downloadedCount: result.downloaded,
		outcomes: result.outcomes,
		bestRejectedScore: rejected?.bestRejectedScore,
		bestRejectedReason: rejected?.bestRejectedReason,
		bestScore: rejected?.bestRejectedScore,
		subtitle: result.subtitle,
		matchScore: downloaded?.matchScore
	};
}

/**
 * POST /api/subtitles/auto-search
 * Search for subtitles and automatically download the best match.
 */
export const POST: RequestHandler = async ({ request }) => {
	const validated = await parseBody(request, autoSearchSchema);

	// Auto-search for movie
	if (validated.movieId) {
		const movie = assertFound(
			await db.query.movies.findFirst({ where: eq(movies.id, validated.movieId) }),
			'Movie',
			validated.movieId
		);

		const result = await autoSearchMovie(movie, {
			languages: validated.languages,
			requirement: validated.requirement
		});

		logger.info(
			{
				movieId: validated.movieId,
				reason: summarizeAutoSearchReason(result),
				downloaded: result.downloaded
			},
			'[AutoSearch] Movie auto-search complete'
		);

		return Response.json(toResponse(result));
	}

	// Auto-search for episode
	if (validated.episodeId) {
		const episode = assertFound(
			await db.query.episodes.findFirst({ where: eq(episodes.id, validated.episodeId) }),
			'Episode',
			validated.episodeId
		);

		const seriesData = assertFound(
			await db.query.series.findFirst({ where: eq(series.id, episode.seriesId) }),
			'Series',
			episode.seriesId
		);

		const result = await autoSearchEpisode(episode, seriesData, {
			languages: validated.languages,
			requirement: validated.requirement
		});

		logger.info(
			{
				episodeId: validated.episodeId,
				reason: summarizeAutoSearchReason(result),
				downloaded: result.downloaded
			},
			'[AutoSearch] Episode auto-search complete'
		);

		return Response.json(toResponse(result));
	}

	return Response.json({ error: 'Either movieId or episodeId is required' }, { status: 400 });
};

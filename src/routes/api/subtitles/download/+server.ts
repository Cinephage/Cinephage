import type { RequestHandler } from './$types';
import { getSubtitleDownloadService } from '#lib/server/subtitles/services/SubtitleDownloadService.js';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { matchesRequirement } from '#lib/server/subtitles/requirement-matcher.js';
import { resetSearchFailure } from '#lib/server/subtitles/subtitle-search-state.js';
import { requirementKey } from '#lib/shared/language-profile.js';
import { subtitleDownloadSchema } from '#lib/validation/schemas.js';
import { db } from '#lib/server/db/index.js';
import { movies, episodes } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { SubtitleSearchResult } from '#lib/server/subtitles/types.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { parseBody, assertFound } from '#lib/server/api/validate.js';

/**
 * A manual download is a user override: reset the per-requirement search
 * backoff for every requirement the placed subtitle satisfies, so a later
 * deletion of that file does not leave the requirement stuck in weekly
 * backoff from earlier failed attempts. Best-effort.
 */
async function resetSatisfiedRequirements(
	ownerType: 'movie' | 'episode',
	ownerId: string,
	subtitle: { language: string; isForced?: boolean; isHearingImpaired?: boolean }
): Promise<void> {
	try {
		const effective = await LanguageProfileService.getInstance().getEffectiveSubtitleRequirements(
			ownerType === 'movie' ? { movieId: ownerId } : { episodeId: ownerId }
		);
		for (const requirement of effective?.requirements ?? []) {
			const satisfied = matchesRequirement(
				{
					language: subtitle.language,
					isForced: subtitle.isForced,
					isHearingImpaired: subtitle.isHearingImpaired
				},
				requirement
			);
			if (satisfied) {
				await resetSearchFailure(ownerType, ownerId, requirementKey(requirement));
			}
		}
	} catch {
		// Best-effort only; never fail a successful download because of state reset.
	}
}

/**
 * POST /api/subtitles/download
 * Download a subtitle from a provider.
 *
 * The body is the full search result selected in the interactive modal. It is
 * forwarded verbatim (minus the media ids) to the download service, which owns
 * format detection, atomic writes, history and media-server notification. In
 * particular `downloadUrl`/`pageLink` must survive: providers such as
 * BetaSeries need a direct download URL that is not reconstructible from ids.
 */
export const POST: RequestHandler = async ({ request }) => {
	const validated = await parseBody(request, subtitleDownloadSchema);
	const downloadService = getSubtitleDownloadService();

	const searchResult: SubtitleSearchResult = {
		providerId: validated.providerId,
		providerName: validated.providerName,
		providerSubtitleId: validated.providerSubtitleId,
		language: validated.language,
		title: validated.title,
		releaseName: validated.releaseName,
		fileName: validated.fileName,
		isForced: validated.isForced,
		isHearingImpaired: validated.isHearingImpaired,
		format: validated.format,
		isHashMatch: validated.isHashMatch,
		matchScore: validated.matchScore,
		downloadUrl: validated.downloadUrl,
		pageLink: validated.pageLink,
		fileSize: validated.fileSize,
		uploadDate: validated.uploadDate,
		downloadCount: validated.downloadCount,
		movieFileId: validated.movieFileId
	};

	// Download for movie
	if (validated.movieId) {
		const movie = await db.query.movies.findFirst({
			where: eq(movies.id, validated.movieId)
		});

		assertFound(movie, 'Movie', validated.movieId);

		const downloadResult = await downloadService.downloadForMovie(validated.movieId, searchResult);
		await resetSatisfiedRequirements('movie', validated.movieId, {
			language: downloadResult.language,
			isForced: searchResult.isForced,
			isHearingImpaired: searchResult.isHearingImpaired
		});
		libraryMediaEvents.emitMovieUpdated(validated.movieId);

		return Response.json({
			success: true,
			subtitle: downloadResult
		});
	}

	// Download for episode
	if (validated.episodeId) {
		const episode = assertFound(
			await db.query.episodes.findFirst({
				where: eq(episodes.id, validated.episodeId)
			}),
			'Episode',
			validated.episodeId
		);

		const downloadResult = await downloadService.downloadForEpisode(
			validated.episodeId,
			searchResult
		);
		await resetSatisfiedRequirements('episode', validated.episodeId, {
			language: downloadResult.language,
			isForced: searchResult.isForced,
			isHearingImpaired: searchResult.isHearingImpaired
		});
		libraryMediaEvents.emitSeriesUpdated(episode.seriesId);

		return Response.json({
			success: true,
			subtitle: downloadResult
		});
	}

	return Response.json({ error: 'Either movieId or episodeId is required' }, { status: 400 });
};

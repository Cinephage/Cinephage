/**
 * Subtitle Import Service
 *
 * Handles immediate subtitle searches triggered by media imports.
 * This is NOT a scheduled task - it runs once when triggered by ImportService
 * or MediaMatcher after new media is added to the library.
 */

import { db } from '#lib/server/db/index.js';
import { movies, series, episodes } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getSubtitleSearchService } from './SubtitleSearchService.js';
import { getSubtitleDownloadService } from './SubtitleDownloadService.js';
import { LanguageProfileService } from './LanguageProfileService.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import { selectBestCandidate } from '../acquisition.js';
import {
	filterSearchEligible,
	recordSearchFailure,
	resetSearchFailure
} from '../subtitle-search-state.js';
import { DEFAULT_MINIMUM_SCORE, requirementKey } from '#lib/shared/language-profile.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import { isMovieMonitored } from '#lib/server/monitoring/specifications/MonitoredSpecification.js';
import { LanguageSettingsService } from './LanguageSettingsService.js';

/**
 * Unique language tags for an effective requirement list (search criteria
 * input). Derived from the EFFECTIVE requirements so per-item overrides are
 * actually queried — never from the profile chain alone.
 */
function requirementLanguages(requirements: SubtitleRequirement[]): string[] {
	return [...new Set(requirements.map((requirement) => requirement.tag))];
}

/**
 * Result of an import-triggered subtitle search
 */
export interface ImportSearchResult {
	downloaded: number;
	errors: string[];
}

/**
 * Search for subtitles immediately after media import.
 *
 * Called by:
 * - ImportService after movie/episode imports complete
 * - MediaMatcher after TMDB metadata matching
 *
 * @param mediaType - 'movie' or 'episode'
 * @param mediaId - The ID of the movie or episode
 * @returns Download count and any errors encountered
 */
export async function searchSubtitlesForNewMedia(
	mediaType: 'movie' | 'episode',
	mediaId: string
): Promise<ImportSearchResult> {
	const result: ImportSearchResult = { downloaded: 0, errors: [] };

	// Auto-sync gate (language_settings singleton): governs import-triggered
	// searches only. Manual "Search now" and scheduled tasks call auto-search
	// directly and intentionally ignore this switch.
	const languageSettings = await LanguageSettingsService.getInstance().get();
	if (!languageSettings.autoSyncSubtitles) {
		logger.debug(
			{ mediaType, mediaId },
			'[SubtitleImportService] autoSyncSubtitles disabled; skipping import search'
		);
		return result;
	}

	const searchService = getSubtitleSearchService();
	const downloadService = getSubtitleDownloadService();
	const profileService = LanguageProfileService.getInstance();

	try {
		if (mediaType === 'movie') {
			const movieResult = await searchForMovie(
				mediaId,
				searchService,
				downloadService,
				profileService
			);
			result.downloaded = movieResult.downloaded;
			result.errors = movieResult.errors;
		} else {
			const episodeResult = await searchForEpisode(
				mediaId,
				searchService,
				downloadService,
				profileService
			);
			result.downloaded = episodeResult.downloaded;
			result.errors = episodeResult.errors;
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		result.errors.push(errorMsg);
		logger.error(
			{
				mediaType,
				mediaId,
				error: errorMsg
			},
			'[SubtitleImportService] Search failed'
		);
	}

	return result;
}

/**
 * Search for subtitles for a newly imported movie
 */
async function searchForMovie(
	movieId: string,
	searchService: ReturnType<typeof getSubtitleSearchService>,
	downloadService: ReturnType<typeof getSubtitleDownloadService>,
	profileService: LanguageProfileService
): Promise<ImportSearchResult> {
	const result: ImportSearchResult = { downloaded: 0, errors: [] };

	const movie = await db.query.movies.findFirst({
		where: eq(movies.id, movieId)
	});

	// Skip if movie doesn't exist, doesn't want subtitles, or has no language profile
	if (!movie) {
		logger.debug({ movieId }, '[SubtitleImportService] Movie not found');
		return result;
	}

	if (movie.wantsSubtitles === false) {
		logger.debug(
			{
				movieId,
				title: movie.title,
				wantsSubtitles: movie.wantsSubtitles
			},
			'[SubtitleImportService] Movie does not want subtitles'
		);
		return result;
	}

	const isMonitored = await isMovieMonitored({ movie });
	if (!isMonitored) {
		logger.debug(
			{
				movieId,
				title: movie.title
			},
			'[SubtitleImportService] Movie is not monitored; skipping subtitles'
		);
		return result;
	}

	// Effective requirements (per-item override → profile chain), resolved
	// read-only — never persisted back onto the item. Override-only items
	// (no profile in the chain) are still searched: requirements are explicit.
	const effective = await profileService.getEffectiveSubtitleRequirements({ movieId });
	if (!effective || effective.requirements.length === 0) {
		logger.debug(
			{
				movieId,
				title: movie.title
			},
			'[SubtitleImportService] Movie has subtitles enabled but no effective requirements'
		);
		return result;
	}

	const languages = requirementLanguages(effective.requirements);
	if (languages.length === 0) {
		return result;
	}

	// Check which subtitles are missing
	const status = await profileService.getMovieSubtitleStatus(movieId);
	if (status.satisfied || status.missing.length === 0) {
		logger.debug(
			{
				movieId,
				title: movie.title
			},
			'[SubtitleImportService] Movie already has required subtitles'
		);
		return result;
	}

	// Per-requirement backoff (shared gate): skip requirements whose window is closed.
	const activeMissing = await filterSearchEligible('movie', movieId, status.missing);
	if (activeMissing.length === 0) {
		logger.debug(
			{ movieId, title: movie.title },
			'[SubtitleImportService] All missing movie requirements are in backoff'
		);
		return result;
	}

	// Search for subtitles. Gate providers that cannot verify HI when any missing
	// requirement is `require-hi`, otherwise such a requirement could hit a
	// provider that cannot prove HI status.
	const requireHearingImpaired = activeMissing.some((r) => r.accessibility === 'require-hi');
	const minScore = effective.profile?.minimumScore ?? DEFAULT_MINIMUM_SCORE;
	const searchResults = await searchService.searchForMovie(movieId, languages, {
		requireHearingImpaired,
		requirements: activeMissing,
		minimumScore: minScore
	});

	logger.info(
		{
			movieId,
			title: movie.title,
			missingLanguages: activeMissing.map((m) => m.tag),
			resultsFound: searchResults.results.length,
			minScore
		},
		'[SubtitleImportService] Searching subtitles for movie'
	);

	// Download best match for each missing requirement
	for (const requirement of activeMissing) {
		const selection = selectBestCandidate(searchResults.results, requirement, minScore);
		const bestMatch = selection.best;

		// Log when we have results but none meet the tuple/threshold
		if (!bestMatch && selection.bestRejected) {
			logger.debug(
				{
					movieId,
					title: movie.title,
					language: requirement.tag,
					bestRejectedScore: selection.bestRejected.result.matchScore,
					bestRejectedReason: selection.bestRejected.reason,
					minScore
				},
				'[SubtitleImportService] No acceptable subtitle for movie requirement'
			);
		}

		if (bestMatch) {
			try {
				await downloadService.downloadForMovie(movieId, bestMatch);
				result.downloaded++;
				await resetSearchFailure('movie', movieId, requirementKey(requirement));

				// History is owned by SubtitleDownloadService (single write).
				const normalizedLanguage = normalizeLanguageCode(bestMatch.language);

				logger.info(
					{
						movieId,
						title: movie.title,
						language: normalizedLanguage,
						provider: bestMatch.providerName,
						score: bestMatch.matchScore
					},
					'[SubtitleImportService] Downloaded subtitle for movie'
				);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				result.errors.push(errorMsg);
				logger.warn(
					{
						movieId,
						title: movie.title,
						language: requirement.tag,
						error: errorMsg
					},
					'[SubtitleImportService] Failed to download subtitle for movie'
				);
				await recordSearchFailure('movie', movieId, requirementKey(requirement));
			}
		} else {
			await recordSearchFailure('movie', movieId, requirementKey(requirement));
		}
	}

	return result;
}

/**
 * Search for subtitles for a newly imported episode
 */
async function searchForEpisode(
	episodeId: string,
	searchService: ReturnType<typeof getSubtitleSearchService>,
	downloadService: ReturnType<typeof getSubtitleDownloadService>,
	profileService: LanguageProfileService
): Promise<ImportSearchResult> {
	const result: ImportSearchResult = { downloaded: 0, errors: [] };

	const episode = await db.query.episodes.findFirst({
		where: eq(episodes.id, episodeId)
	});

	if (!episode) {
		logger.debug({ episodeId }, '[SubtitleImportService] Episode not found');
		return result;
	}

	// Check if episode has explicitly disabled subtitles
	if (episode.wantsSubtitlesOverride === false) {
		logger.debug(
			{
				episodeId,
				title: episode.title
			},
			'[SubtitleImportService] Episode has subtitles disabled'
		);
		return result;
	}

	const seriesData = await db.query.series.findFirst({
		where: eq(series.id, episode.seriesId)
	});

	// Skip if series doesn't exist or doesn't want subtitles (tri-state: the
	// episode override above forces subtitles on when set to true, so a series
	// opt-out only applies when the episode inherits).
	if (!seriesData) {
		logger.debug(
			{
				episodeId,
				seriesId: episode.seriesId
			},
			'[SubtitleImportService] Series not found for episode'
		);
		return result;
	}

	if ((episode.wantsSubtitlesOverride ?? seriesData.wantsSubtitles) === false) {
		logger.debug(
			{
				episodeId,
				seriesId: seriesData.id,
				seriesTitle: seriesData.title,
				wantsSubtitles: seriesData.wantsSubtitles
			},
			'[SubtitleImportService] Subtitles are gated off for this episode'
		);
		return result;
	}

	if (!seriesData.monitored || !episode.monitored) {
		logger.debug(
			{
				episodeId,
				seriesTitle: seriesData.title,
				season: episode.seasonNumber,
				episode: episode.episodeNumber
			},
			'[SubtitleImportService] Episode is not monitored; skipping subtitles'
		);
		return result;
	}

	// Effective requirements (episode override → series override → library →
	// instance default), resolved read-only — never persisted back onto the
	// series. Override-only episodes are still searched.
	const effective = await profileService.getEffectiveSubtitleRequirements({ episodeId });
	if (!effective || effective.requirements.length === 0) {
		logger.debug(
			{
				episodeId,
				seriesId: seriesData.id,
				seriesTitle: seriesData.title
			},
			'[SubtitleImportService] Episode has subtitles enabled but no effective requirements'
		);
		return result;
	}

	const languages = requirementLanguages(effective.requirements);
	if (languages.length === 0) {
		return result;
	}

	// Check which subtitles are missing
	const status = await profileService.getEpisodeSubtitleStatus(episodeId);
	if (status.satisfied || status.missing.length === 0) {
		logger.debug(
			{
				episodeId,
				seriesTitle: seriesData.title,
				season: episode.seasonNumber,
				episode: episode.episodeNumber
			},
			'[SubtitleImportService] Episode already has required subtitles'
		);
		return result;
	}

	// Per-requirement backoff (shared gate): skip requirements whose window is closed.
	const activeMissing = await filterSearchEligible('episode', episodeId, status.missing);
	if (activeMissing.length === 0) {
		logger.debug(
			{ episodeId, seriesTitle: seriesData.title },
			'[SubtitleImportService] All missing episode requirements are in backoff'
		);
		return result;
	}

	// Search for subtitles. Gate providers that cannot verify HI when any missing
	// requirement is `require-hi`, otherwise such a requirement could hit a
	// provider that cannot prove HI status.
	const requireHearingImpaired = activeMissing.some((r) => r.accessibility === 'require-hi');
	const minScore = effective.profile?.minimumScore ?? DEFAULT_MINIMUM_SCORE;
	const searchResults = await searchService.searchForEpisode(episodeId, languages, {
		requireHearingImpaired,
		requirements: activeMissing,
		minimumScore: minScore
	});

	logger.info(
		{
			episodeId,
			seriesTitle: seriesData.title,
			season: episode.seasonNumber,
			episode: episode.episodeNumber,
			missingLanguages: activeMissing.map((m) => m.tag),
			resultsFound: searchResults.results.length,
			minScore
		},
		'[SubtitleImportService] Searching subtitles for episode'
	);

	// Download best match for each missing requirement
	for (const requirement of activeMissing) {
		const selection = selectBestCandidate(searchResults.results, requirement, minScore);
		const bestMatch = selection.best;

		// Log when we have results but none meet the tuple/threshold
		if (!bestMatch && selection.bestRejected) {
			logger.debug(
				{
					episodeId,
					seriesTitle: seriesData.title,
					season: episode.seasonNumber,
					episode: episode.episodeNumber,
					language: requirement.tag,
					bestRejectedScore: selection.bestRejected.result.matchScore,
					bestRejectedReason: selection.bestRejected.reason,
					minScore
				},
				'[SubtitleImportService] No acceptable subtitle for episode requirement'
			);
		}

		if (bestMatch) {
			try {
				await downloadService.downloadForEpisode(episodeId, bestMatch);
				result.downloaded++;
				await resetSearchFailure('episode', episodeId, requirementKey(requirement));

				// History is owned by SubtitleDownloadService (single write).
				const normalizedLanguage = normalizeLanguageCode(bestMatch.language);

				logger.info(
					{
						episodeId,
						seriesTitle: seriesData.title,
						season: episode.seasonNumber,
						episode: episode.episodeNumber,
						language: normalizedLanguage,
						provider: bestMatch.providerName,
						score: bestMatch.matchScore
					},
					'[SubtitleImportService] Downloaded subtitle for episode'
				);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				result.errors.push(errorMsg);
				logger.warn(
					{
						episodeId,
						seriesTitle: seriesData.title,
						season: episode.seasonNumber,
						episode: episode.episodeNumber,
						language: requirement.tag,
						error: errorMsg
					},
					'[SubtitleImportService] Failed to download subtitle for episode'
				);
				await recordSearchFailure('episode', episodeId, requirementKey(requirement));
			}
		} else {
			await recordSearchFailure('episode', episodeId, requirementKey(requirement));
		}
	}

	return result;
}

/**
 * Batch search result
 */
export interface BatchSearchResult {
	processed: number;
	downloaded: number;
	errors: number;
}

/**
 * Search for subtitles for multiple media items with rate limiting.
 *
 * Used when:
 * - User enables subtitle monitoring on a series (search all episodes)
 * - User bulk-assigns a language profile to multiple items
 *
 * Runs in background (fire-and-forget) to avoid blocking the API response.
 *
 * @param items - Array of media items to search
 * @param options - Rate limiting options
 */
export async function searchSubtitlesForMediaBatch(
	items: Array<{ mediaType: 'movie' | 'episode'; mediaId: string }>,
	options?: { delayMs?: number; maxItems?: number }
): Promise<BatchSearchResult> {
	const { delayMs = 1000, maxItems = 50 } = options ?? {};

	const result: BatchSearchResult = {
		processed: 0,
		downloaded: 0,
		errors: 0
	};

	// Limit batch size to avoid overwhelming providers
	const itemsToProcess = items.slice(0, maxItems);

	logger.info(
		{
			totalItems: items.length,
			processingItems: itemsToProcess.length,
			delayMs
		},
		'[SubtitleImportService] Starting batch subtitle search'
	);

	for (const item of itemsToProcess) {
		try {
			const searchResult = await searchSubtitlesForNewMedia(item.mediaType, item.mediaId);
			result.processed++;
			result.downloaded += searchResult.downloaded;
			result.errors += searchResult.errors.length;
		} catch (error) {
			result.processed++;
			result.errors++;
			logger.warn(
				{
					mediaType: item.mediaType,
					mediaId: item.mediaId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[SubtitleImportService] Batch search item failed'
			);
		}

		// Rate limit: delay between searches
		if (result.processed < itemsToProcess.length) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	logger.info(
		{
			processed: result.processed,
			downloaded: result.downloaded,
			errors: result.errors
		},
		'[SubtitleImportService] Batch subtitle search completed'
	);

	return result;
}

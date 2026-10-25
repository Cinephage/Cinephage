/**
 * Missing Subtitles Task
 *
 * Searches for subtitles on monitored media that have files but lack required
 * subtitles per their language profile. Runs periodically (default: every 6 hours).
 *
 * Backoff is per requirement (`subtitle_search_state`): one failing requirement
 * never gates another for the same movie/episode, and a success resets only the
 * requirement that was filled. Candidate downloads go through the shared
 * acquisition helper so the requirement tuple is always honoured.
 */

import { db } from '#lib/server/db/index.js';
import { movies, series, episodes, monitoringHistory } from '#lib/server/db/schema.js';
import { eq, and, or, exists } from 'drizzle-orm';
import { getSubtitleSearchService } from '#lib/server/subtitles/services/SubtitleSearchService.js';
import { getSubtitleDownloadService } from '#lib/server/subtitles/services/SubtitleDownloadService.js';
import { getSubtitleProviderManager } from '#lib/server/subtitles/services/SubtitleProviderManager.js';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { selectBestCandidate } from '#lib/server/subtitles/acquisition.js';
import {
	filterSearchEligible,
	recordSearchFailure,
	resetSearchFailure
} from '#lib/server/subtitles/subtitle-search-state.js';
import { DEFAULT_MINIMUM_SCORE, requirementKey } from '#lib/shared/language-profile.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { isMovieMonitored } from '#lib/server/monitoring/specifications/MonitoredSpecification.js';

const logger = createChildLogger({ module: 'MissingSubtitlesTask', logDomain: 'monitoring' });

/**
 * Maximum concurrent subtitle searches to avoid overwhelming providers
 */
const MAX_CONCURRENT_SEARCHES = 3;

/**
 * Delay in milliseconds between search batches to prevent rate limiting
 */
const BATCH_DELAY_MS = 1000;

/**
 * Delay in milliseconds between individual searches within a batch
 */
const SEARCH_DELAY_MS = 200;

/**
 * Sleep utility
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unique language tags for a set of requirements (search criteria input). */
function requirementLanguages(requirements: SubtitleRequirement[]): string[] {
	return [...new Set(requirements.map((requirement) => requirement.tag))];
}

/**
 * Execute missing subtitles search task
 * @param ctx - Execution context for cancellation support and activity tracking
 */
export async function executeMissingSubtitlesTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	const taskHistoryId = ctx?.historyId;
	logger.info({ taskHistoryId }, '[MissingSubtitlesTask] Starting missing subtitles search');

	// Check for cancellation before starting
	ctx?.checkCancelled();

	// Check provider health status
	const providerManager = getSubtitleProviderManager();
	const healthStatus = await providerManager.getHealthStatus();
	const throttledProviders = healthStatus.filter((h) => h.isThrottled);
	const unhealthyProviders = healthStatus.filter((h) => !h.isHealthy && !h.isThrottled);

	// Log provider health for observability
	if (throttledProviders.length > 0) {
		logger.info(
			{
				count: throttledProviders.length,
				providers: throttledProviders.map((p) => ({
					name: p.providerName,
					until: p.throttledUntil,
					error: p.throttleErrorType
				}))
			},
			'[MissingSubtitlesTask] Throttled providers'
		);
	}

	if (unhealthyProviders.length > 0) {
		logger.info(
			{
				count: unhealthyProviders.length,
				providers: unhealthyProviders.map((p) => ({
					name: p.providerName,
					failures: p.consecutiveFailures,
					lastError: p.lastError
				}))
			},
			'[MissingSubtitlesTask] Unhealthy providers'
		);
	}

	const availableProviders = await providerManager.getEnabledProviders();

	if (availableProviders.length === 0) {
		logger.warn(
			'[MissingSubtitlesTask] No subtitle providers available (all throttled or disabled), skipping search'
		);
		return {
			taskType: 'missingSubtitles',
			itemsProcessed: 0,
			itemsGrabbed: 0,
			errors: 0,
			executedAt
		};
	}

	logger.info(
		{
			count: availableProviders.length,
			providers: availableProviders.map((p) => p.name),
			totalConfigured: healthStatus.length
		},
		'[MissingSubtitlesTask] Available providers'
	);

	let itemsProcessed = 0;
	let itemsGrabbed = 0;
	let errors = 0;

	const searchService = getSubtitleSearchService();
	const downloadService = getSubtitleDownloadService();
	const profileService = LanguageProfileService.getInstance();

	try {
		// Search for missing subtitles on movies
		logger.info('[MissingSubtitlesTask] Searching for missing movie subtitles');
		const movieResults = await searchMissingMovieSubtitles(
			searchService,
			downloadService,
			profileService,
			executedAt,
			taskHistoryId,
			ctx
		);

		itemsProcessed += movieResults.processed;
		itemsGrabbed += movieResults.downloaded;
		errors += movieResults.errors;

		logger.info(
			{
				processed: movieResults.processed,
				downloaded: movieResults.downloaded,
				errors: movieResults.errors
			},
			'[MissingSubtitlesTask] Missing movie subtitles search completed'
		);

		// Check for cancellation before episode search
		ctx?.checkCancelled();

		// Search for missing subtitles on episodes
		logger.info('[MissingSubtitlesTask] Searching for missing episode subtitles');
		const episodeResults = await searchMissingEpisodeSubtitles(
			searchService,
			downloadService,
			profileService,
			executedAt,
			taskHistoryId,
			ctx
		);

		itemsProcessed += episodeResults.processed;
		itemsGrabbed += episodeResults.downloaded;
		errors += episodeResults.errors;

		logger.info(
			{
				processed: episodeResults.processed,
				downloaded: episodeResults.downloaded,
				errors: episodeResults.errors
			},
			'[MissingSubtitlesTask] Missing episode subtitles search completed'
		);

		logger.info(
			{
				totalProcessed: itemsProcessed,
				totalDownloaded: itemsGrabbed,
				totalErrors: errors
			},
			'[MissingSubtitlesTask] Task completed'
		);

		return {
			taskType: 'missingSubtitles',
			itemsProcessed,
			itemsGrabbed,
			errors,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[MissingSubtitlesTask] Task failed');
		throw error;
	}
}

/**
 * Search for missing subtitles on movies
 */
async function searchMissingMovieSubtitles(
	searchService: ReturnType<typeof getSubtitleSearchService>,
	downloadService: ReturnType<typeof getSubtitleDownloadService>,
	profileService: LanguageProfileService,
	executedAt: Date,
	taskHistoryId?: string,
	ctx?: TaskExecutionContext | null
): Promise<{ processed: number; downloaded: number; errors: number }> {
	let processed = 0;
	let downloaded = 0;
	let errorCount = 0;

	// Get movies with files that want subtitles and have a language profile
	const moviesWithProfiles = await db
		.select()
		.from(movies)
		.where(
			and(eq(movies.hasFile, true), eq(movies.wantsSubtitles, true), eq(movies.monitored, true))
		);

	logger.debug(
		{
			count: moviesWithProfiles.length
		},
		'[MissingSubtitlesTask] Found movies to process'
	);

	// Get provider manager for per-batch health checks
	const providerManager = getSubtitleProviderManager();

	// Process movies in batches to limit concurrency
	for (let i = 0; i < moviesWithProfiles.length; i += MAX_CONCURRENT_SEARCHES) {
		// Check for cancellation between batches
		ctx?.checkCancelled();

		// Re-check provider availability each batch (Bazarr pattern: break when all throttled)
		const currentProviders = await providerManager.getEnabledProviders();
		if (currentProviders.length === 0) {
			logger.warn(
				'[MissingSubtitlesTask] All providers throttled or disabled mid-run, stopping movie search'
			);
			break;
		}

		const batch = moviesWithProfiles.slice(i, i + MAX_CONCURRENT_SEARCHES);

		// Add delay between batches to prevent rate limiting (skip first batch)
		if (i > 0) {
			if (ctx) {
				await ctx.delay(BATCH_DELAY_MS);
			} else {
				await sleep(BATCH_DELAY_MS);
			}
		}

		await Promise.all(
			batch.map(async (movie, batchIndex) => {
				const isMonitored = await isMovieMonitored({ movie });
				if (!isMonitored) {
					return;
				}

				// Stagger searches within batch
				if (batchIndex > 0) {
					await sleep(SEARCH_DELAY_MS * batchIndex);
				}

				let movieDownloaded = 0;
				let movieError: string | undefined;
				const downloadedLanguages: string[] = [];

				try {
					// Check if subtitles are missing
					const status = await profileService.getMovieSubtitleStatus(movie.id);

					if (status.satisfied || status.missing.length === 0) {
						// Already has all required subtitles
						return;
					}

					// Effective profile (item override → library → instance default),
					// resolved read-only — never persisted back onto the item.
					const effective = await profileService.getEffectiveProfileForMovie(movie.id);
					if (!effective) return;
					const profile = effective.profile;

					const minScore = profile.minimumScore ?? DEFAULT_MINIMUM_SCORE;

					// Per-requirement backoff: attempt only requirements whose
					// individual window is open.
					const activeMissing = await filterSearchEligible('movie', movie.id, status.missing);
					if (activeMissing.length === 0) return;

					processed++;

					const languages = requirementLanguages(activeMissing);
					if (languages.length === 0) return;

					const missingCodes = activeMissing.map((m) => m.tag).join(', ');
					const missingLabel = missingCodes ? `Subtitles: ${missingCodes}` : undefined;

					// Search for subtitles. Gate providers that cannot verify HI when
					// any requirement being acquired is `require-hi`, otherwise such a
					// requirement could hit a provider that cannot prove HI status.
					const requireHearingImpaired = activeMissing.some(
						(r) => r.accessibility === 'require-hi'
					);
					const results = await searchService.searchForMovie(movie.id, languages, {
						requireHearingImpaired,
						requirements: activeMissing,
						minimumScore: minScore
					});

					// Download best match for each missing requirement
					for (const requirement of activeMissing) {
						const key = requirementKey(requirement);
						const selection = selectBestCandidate(results.results, requirement, minScore);

						if (!selection.best) {
							await recordSearchFailure('movie', movie.id, key);
							if (selection.bestRejected) {
								logger.debug(
									{
										movieId: movie.id,
										title: movie.title,
										language: requirement.tag,
										bestRejectedScore: selection.bestRejected.result.matchScore,
										bestRejectedReason: selection.bestRejected.reason,
										minScore
									},
									'[MissingSubtitlesTask] No acceptable subtitle for movie requirement'
								);
							}
							continue;
						}

						const bestMatch = selection.best;
						try {
							await downloadService.downloadForMovie(movie.id, bestMatch);
							downloaded++;
							movieDownloaded++;

							const normalizedLanguage = normalizeLanguageCode(bestMatch.language);

							// History is owned by SubtitleDownloadService (single write).
							downloadedLanguages.push(normalizedLanguage);

							// Reset only this requirement's backoff.
							await resetSearchFailure('movie', movie.id, key);

							logger.debug(
								{
									movieId: movie.id,
									language: normalizedLanguage,
									score: bestMatch.matchScore
								},
								'[MissingSubtitlesTask] Downloaded subtitle for movie'
							);
						} catch (downloadError) {
							errorCount++;
							movieError =
								downloadError instanceof Error ? downloadError.message : String(downloadError);
							await recordSearchFailure('movie', movie.id, key);
							logger.warn(
								{
									movieId: movie.id,
									language: requirement.tag,
									error: movieError
								},
								'[MissingSubtitlesTask] Failed to download subtitle for movie'
							);
						}
					}

					// Record to monitoring history for activity tracking
					await db.insert(monitoringHistory).values({
						taskHistoryId,
						taskType: 'missingSubtitles',
						movieId: movie.id,
						status: movieDownloaded > 0 ? 'grabbed' : movieError ? 'error' : 'no_results',
						releasesFound: activeMissing.length,
						releaseGrabbed:
							movieDownloaded > 0 && downloadedLanguages.length > 0
								? `subtitles: ${downloadedLanguages.join(', ')}`
								: undefined,
						isUpgrade: false,
						errorMessage: movieError ?? (movieDownloaded === 0 ? missingLabel : undefined),
						executedAt: executedAt.toISOString()
					});
				} catch (error) {
					errorCount++;
					const errorMsg = error instanceof Error ? error.message : String(error);
					logger.warn(
						{
							movieId: movie.id,
							error: errorMsg
						},
						'[MissingSubtitlesTask] Error processing movie'
					);

					// Record error to monitoring history
					await db.insert(monitoringHistory).values({
						taskHistoryId,
						taskType: 'missingSubtitles',
						movieId: movie.id,
						status: 'error',
						releasesFound: 0,
						isUpgrade: false,
						errorMessage: errorMsg,
						executedAt: executedAt.toISOString()
					});
				}
			})
		);
	}

	return { processed, downloaded, errors: errorCount };
}

/**
 * Search for missing subtitles on episodes
 */
async function searchMissingEpisodeSubtitles(
	searchService: ReturnType<typeof getSubtitleSearchService>,
	downloadService: ReturnType<typeof getSubtitleDownloadService>,
	profileService: LanguageProfileService,
	executedAt: Date,
	taskHistoryId?: string,
	ctx?: TaskExecutionContext | null
): Promise<{ processed: number; downloaded: number; errors: number }> {
	let processed = 0;
	let downloaded = 0;
	let errorCount = 0;

	// Get monitored series that either want subtitles or have at least one
	// episode forcing them on (tri-state episode override wins over the series
	// opt-out, so an opted-out series with a force-on episode must be included).
	const seriesWithProfiles = await db
		.select()
		.from(series)
		.where(
			and(
				eq(series.monitored, true),
				or(
					eq(series.wantsSubtitles, true),
					exists(
						db
							.select({ id: episodes.id })
							.from(episodes)
							.where(
								and(eq(episodes.seriesId, series.id), eq(episodes.wantsSubtitlesOverride, true))
							)
					)
				)
			)
		);

	logger.debug(
		{
			count: seriesWithProfiles.length
		},
		'[MissingSubtitlesTask] Found series to process'
	);

	// Get provider manager for per-batch health checks
	const providerManager = getSubtitleProviderManager();

	for (const show of seriesWithProfiles) {
		// Re-check provider availability per series (break when all throttled)
		const seriesProviders = await providerManager.getEnabledProviders();
		if (seriesProviders.length === 0) {
			logger.warn(
				'[MissingSubtitlesTask] All providers throttled or disabled mid-run, stopping episode search'
			);
			break;
		}

		try {
			// Effective profile (item override → library → instance default),
			// resolved read-only — never persisted back onto the series. May be
			// null for override-only episodes: requirements still resolve per
			// episode, policy falls back to the default score.
			const effective = await profileService.getEffectiveProfileForSeries(show.id);
			const minScore = effective?.profile.minimumScore ?? DEFAULT_MINIMUM_SCORE;

			// Get episodes missing subtitles
			const episodesMissing = await profileService.getSeriesEpisodesMissingSubtitles(show.id);
			if (episodesMissing.length === 0) continue;

			// Process episodes in batches
			for (let i = 0; i < episodesMissing.length; i += MAX_CONCURRENT_SEARCHES) {
				// Check for cancellation between batches
				ctx?.checkCancelled();

				// Re-check provider availability each batch (Bazarr pattern: break when all throttled)
				const currentProviders = await providerManager.getEnabledProviders();
				if (currentProviders.length === 0) {
					logger.warn(
						'[MissingSubtitlesTask] All providers throttled or disabled mid-run, stopping episode search'
					);
					break;
				}

				const batch = episodesMissing.slice(i, i + MAX_CONCURRENT_SEARCHES);

				// Add delay between batches to prevent rate limiting (skip first batch)
				if (i > 0) {
					if (ctx) {
						await ctx.delay(BATCH_DELAY_MS);
					} else {
						await sleep(BATCH_DELAY_MS);
					}
				}

				await Promise.all(
					batch.map(async (episodeId, batchIndex) => {
						// Stagger searches within batch
						if (batchIndex > 0) {
							await sleep(SEARCH_DELAY_MS * batchIndex);
						}

						let episodeDownloaded = 0;
						let episodeError: string | undefined;
						const downloadedLanguages: string[] = [];

						try {
							// Check if episode has explicitly disabled subtitles
							const episodeData = await db.query.episodes.findFirst({
								where: eq(episodes.id, episodeId)
							});

							// Preflight: file present, not opted out (tri-state override
							// wins over the series flag), monitored.
							if (!episodeData?.hasFile) {
								return;
							}

							if ((episodeData.wantsSubtitlesOverride ?? show.wantsSubtitles) === false) {
								return;
							}

							if (!episodeData.monitored) {
								return;
							}

							// Get status for this episode
							const status = await profileService.getEpisodeSubtitleStatus(episodeId);

							// Per-requirement backoff.
							const activeMissing = await filterSearchEligible(
								'episode',
								episodeId,
								status.missing
							);
							if (activeMissing.length === 0) return;

							processed++;

							const languages = requirementLanguages(activeMissing);
							if (languages.length === 0) return;

							const missingCodes = activeMissing.map((m) => m.tag).join(', ');
							const missingLabel = missingCodes ? `Subtitles: ${missingCodes}` : undefined;

							// Search for subtitles. Gate providers that cannot verify HI
							// when any requirement being acquired is `require-hi`.
							const requireHearingImpaired = activeMissing.some(
								(r) => r.accessibility === 'require-hi'
							);
							const results = await searchService.searchForEpisode(episodeId, languages, {
								requireHearingImpaired,
								requirements: activeMissing,
								minimumScore: minScore
							});

							for (const requirement of activeMissing) {
								const key = requirementKey(requirement);
								const selection = selectBestCandidate(results.results, requirement, minScore);

								if (!selection.best) {
									await recordSearchFailure('episode', episodeId, key);
									if (selection.bestRejected) {
										logger.debug(
											{
												episodeId,
												language: requirement.tag,
												bestRejectedScore: selection.bestRejected.result.matchScore,
												bestRejectedReason: selection.bestRejected.reason,
												minScore
											},
											'[MissingSubtitlesTask] No acceptable subtitle for episode requirement'
										);
									}
									continue;
								}

								const bestMatch = selection.best;
								try {
									await downloadService.downloadForEpisode(episodeId, bestMatch);
									downloaded++;
									episodeDownloaded++;

									const normalizedLanguage = normalizeLanguageCode(bestMatch.language);

									// History is owned by SubtitleDownloadService (single write).
									downloadedLanguages.push(normalizedLanguage);

									// Reset only this requirement's backoff.
									await resetSearchFailure('episode', episodeId, key);

									logger.debug(
										{
											episodeId,
											language: normalizedLanguage,
											score: bestMatch.matchScore
										},
										'[MissingSubtitlesTask] Downloaded subtitle for episode'
									);
								} catch (downloadError) {
									errorCount++;
									episodeError =
										downloadError instanceof Error ? downloadError.message : String(downloadError);
									await recordSearchFailure('episode', episodeId, key);
									logger.warn(
										{
											episodeId,
											language: requirement.tag,
											error: episodeError
										},
										'[MissingSubtitlesTask] Failed to download subtitle for episode'
									);
								}
							}

							// Record to monitoring history for activity tracking
							await db.insert(monitoringHistory).values({
								taskHistoryId,
								taskType: 'missingSubtitles',
								episodeId: episodeId,
								seriesId: show.id,
								status: episodeDownloaded > 0 ? 'grabbed' : episodeError ? 'error' : 'no_results',
								releasesFound: activeMissing.length,
								releaseGrabbed:
									episodeDownloaded > 0 && downloadedLanguages.length > 0
										? `subtitles: ${downloadedLanguages.join(', ')}`
										: undefined,
								isUpgrade: false,
								errorMessage: episodeError ?? (episodeDownloaded === 0 ? missingLabel : undefined),
								executedAt: executedAt.toISOString()
							});
						} catch (error) {
							errorCount++;
							const errorMsg = error instanceof Error ? error.message : String(error);
							logger.warn(
								{
									episodeId,
									error: errorMsg
								},
								'[MissingSubtitlesTask] Error processing episode'
							);

							// Record error to monitoring history
							await db.insert(monitoringHistory).values({
								taskHistoryId,
								taskType: 'missingSubtitles',
								episodeId: episodeId,
								seriesId: show.id,
								status: 'error',
								releasesFound: 0,
								isUpgrade: false,
								errorMessage: errorMsg,
								executedAt: executedAt.toISOString()
							});
						}
					})
				);
			}
		} catch (error) {
			errorCount++;
			logger.warn(
				{
					seriesId: show.id,
					error: error instanceof Error ? error.message : String(error)
				},
				'[MissingSubtitlesTask] Error processing series'
			);
		}
	}

	return { processed, downloaded, errors: errorCount };
}

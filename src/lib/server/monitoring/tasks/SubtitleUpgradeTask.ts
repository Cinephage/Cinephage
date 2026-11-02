/**
 * Subtitle Upgrade Task
 *
 * Searches for better-scoring subtitles for existing ones when the language profile
 * allows upgrades. Runs periodically (default: daily) to improve subtitle quality.
 *
 * Rotation: candidate rows are ordered by `last_checked_at` ASC (NULLs first) and
 * `last_checked_at` is stamped for every row examined, so a capped run does not
 * re-check the same first 50 subtitles forever.
 *
 * A candidate may only replace an existing subtitle that satisfies the SAME
 * requirement tuple (language + variant + accessibility). A regular subtitle
 * cannot replace a forced one and vice versa, even when it scores higher.
 */

import { db } from '#lib/server/db/index.js';
import { movies, series, episodes, subtitles, monitoringHistory } from '#lib/server/db/schema.js';
import { eq, and, isNotNull, asc, inArray, or, isNull } from 'drizzle-orm';
import { getSubtitleSearchService } from '#lib/server/subtitles/services/SubtitleSearchService.js';
import { getSubtitleDownloadService } from '#lib/server/subtitles/services/SubtitleDownloadService.js';
import { getSubtitleProviderManager } from '#lib/server/subtitles/services/SubtitleProviderManager.js';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { selectCandidates } from '#lib/server/subtitles/acquisition.js';
import { matchesRequirement } from '#lib/server/subtitles/requirement-matcher.js';
import {
	filterSearchEligible,
	recordSearchFailure,
	resetSearchFailure
} from '#lib/server/subtitles/subtitle-search-state.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import { requirementKey } from '#lib/shared/language-profile.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { isMovieMonitored } from '#lib/server/monitoring/specifications/MonitoredSpecification.js';

const logger = createChildLogger({ module: 'SubtitleUpgradeTask', logDomain: 'monitoring' });

/**
 * Maximum subtitles to process per run to prevent overwhelming providers
 */
const MAX_SUBTITLES_PER_RUN = 50;

/**
 * Maximum concurrent searches
 */
const MAX_CONCURRENT_SEARCHES = 3;

/**
 * Minimum score improvement required to trigger an upgrade
 */
const MIN_SCORE_IMPROVEMENT = 10;

/**
 * Execute subtitle upgrade task
 * @param ctx - Execution context for cancellation support and activity tracking
 */
export async function executeSubtitleUpgradeTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	const taskHistoryId = ctx?.historyId;
	logger.info({ taskHistoryId }, '[SubtitleUpgradeTask] Starting subtitle upgrade search');

	let itemsProcessed = 0;
	let itemsGrabbed = 0;
	let errors = 0;

	// Check provider availability before starting (was missing - unlike MissingSubtitlesTask)
	const providerManager = getSubtitleProviderManager();
	const availableProviders = await providerManager.getEnabledProviders();
	if (availableProviders.length === 0) {
		logger.warn(
			'[SubtitleUpgradeTask] No subtitle providers available (all throttled or disabled), skipping upgrade search'
		);
		return {
			taskType: 'subtitleUpgrade',
			itemsProcessed: 0,
			itemsGrabbed: 0,
			errors: 0,
			executedAt
		};
	}

	logger.info(
		{
			count: availableProviders.length,
			providers: availableProviders.map((p) => p.name)
		},
		'[SubtitleUpgradeTask] Available providers'
	);

	const searchService = getSubtitleSearchService();
	const downloadService = getSubtitleDownloadService();
	const profileService = LanguageProfileService.getInstance();

	try {
		// Check for cancellation before starting
		ctx?.checkCancelled();

		// Process movie subtitle upgrades
		logger.info('[SubtitleUpgradeTask] Searching for movie subtitle upgrades');
		const movieResults = await searchMovieSubtitleUpgrades(
			searchService,
			downloadService,
			profileService,
			executedAt,
			taskHistoryId,
			ctx
		);

		itemsProcessed += movieResults.processed;
		itemsGrabbed += movieResults.upgraded;
		errors += movieResults.errors;

		logger.info(
			{
				processed: movieResults.processed,
				upgraded: movieResults.upgraded,
				errors: movieResults.errors
			},
			'[SubtitleUpgradeTask] Movie subtitle upgrades completed'
		);

		// Check for cancellation before episode upgrades
		ctx?.checkCancelled();

		// Process episode subtitle upgrades
		logger.info('[SubtitleUpgradeTask] Searching for episode subtitle upgrades');
		const episodeResults = await searchEpisodeSubtitleUpgrades(
			searchService,
			downloadService,
			profileService,
			executedAt,
			taskHistoryId,
			ctx
		);

		itemsProcessed += episodeResults.processed;
		itemsGrabbed += episodeResults.upgraded;
		errors += episodeResults.errors;

		logger.info(
			{
				processed: episodeResults.processed,
				upgraded: episodeResults.upgraded,
				errors: episodeResults.errors
			},
			'[SubtitleUpgradeTask] Episode subtitle upgrades completed'
		);

		logger.info(
			{
				totalProcessed: itemsProcessed,
				totalUpgraded: itemsGrabbed,
				totalErrors: errors
			},
			'[SubtitleUpgradeTask] Task completed'
		);

		return {
			taskType: 'subtitleUpgrade',
			itemsProcessed,
			itemsGrabbed,
			errors,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[SubtitleUpgradeTask] Task failed');
		throw error;
	}
}

/**
 * How specifically a requirement constrains a subtitle. Exact variants
 * (regular/forced) beat `both`; explicit HI rules beat `any`/`prefer-hi`.
 * A regular row matching `[en|both, en|regular]` must map to the regular
 * requirement, or an upgrade could replace it with a forced candidate and
 * flip the regular requirement to missing.
 */
function requirementSpecificity(requirement: SubtitleRequirement): number {
	let score = 0;
	if (requirement.variant !== 'both') score += 2;
	if (requirement.accessibility === 'require-hi' || requirement.accessibility === 'exclude-hi') {
		score += 1;
	}
	return score;
}

/**
 * Find the profile requirement an existing subtitle satisfies, if any.
 * Used to keep upgrades within the same requirement tuple. When several
 * requirements match, the most specific one wins (ties keep profile order).
 */
function requirementForSubtitle(
	profileRequirements: SubtitleRequirement[],
	subtitle: typeof subtitles.$inferSelect
): SubtitleRequirement | undefined {
	let best: SubtitleRequirement | undefined;
	let bestScore = -1;
	for (const requirement of profileRequirements) {
		const matches = matchesRequirement(
			{
				language: subtitle.language,
				isForced: subtitle.isForced,
				isHearingImpaired: subtitle.isHearingImpaired
			},
			requirement
		);
		if (!matches) continue;
		const score = requirementSpecificity(requirement);
		if (score > bestScore) {
			best = requirement;
			bestScore = score;
		}
	}
	return best;
}

/**
 * Stamp `last_checked_at` for every subtitle row examined this run so rotation
 * advances even when no upgrade is found.
 */
async function markSubtitlesChecked(ids: string[], nowIso: string): Promise<void> {
	if (ids.length === 0) return;
	await db.update(subtitles).set({ lastCheckedAt: nowIso }).where(inArray(subtitles.id, ids));
}

/**
 * Search for subtitle upgrades on movies
 */
async function searchMovieSubtitleUpgrades(
	searchService: ReturnType<typeof getSubtitleSearchService>,
	downloadService: ReturnType<typeof getSubtitleDownloadService>,
	profileService: LanguageProfileService,
	executedAt: Date,
	taskHistoryId?: string,
	ctx?: TaskExecutionContext | null
): Promise<{ processed: number; upgraded: number; errors: number }> {
	let processed = 0;
	let upgraded = 0;
	let errorCount = 0;

	// Get movie subtitles with scores, oldest-checked first. Preflight filters
	// (hasFile/monitored/wantsSubtitles) are applied in the query so opted-out or
	// fileless rows are never scanned.
	const movieSubtitles = await db
		.select({
			subtitle: subtitles,
			movie: movies
		})
		.from(subtitles)
		.innerJoin(movies, eq(subtitles.movieId, movies.id))
		.where(
			and(
				isNotNull(subtitles.movieId),
				isNotNull(subtitles.matchScore),
				eq(movies.monitored, true),
				eq(movies.hasFile, true),
				eq(movies.wantsSubtitles, true)
			)
		)
		.orderBy(asc(subtitles.lastCheckedAt), asc(subtitles.id))
		.limit(MAX_SUBTITLES_PER_RUN);

	logger.debug(
		{
			count: movieSubtitles.length
		},
		'[SubtitleUpgradeTask] Found movie subtitles to evaluate'
	);

	// Rotation advances for every row examined, upgrade or not.
	await markSubtitlesChecked(
		movieSubtitles.map((row) => row.subtitle.id),
		executedAt.toISOString()
	);

	// Group by movie to avoid duplicate searches
	const movieMap = new Map<
		string,
		{ movie: typeof movies.$inferSelect; subtitles: (typeof subtitles.$inferSelect)[] }
	>();

	for (const row of movieSubtitles) {
		const existing = movieMap.get(row.movie.id);
		if (existing) {
			existing.subtitles.push(row.subtitle);
		} else {
			movieMap.set(row.movie.id, { movie: row.movie, subtitles: [row.subtitle] });
		}
	}

	// Get provider manager for per-batch health checks
	const providerManager = getSubtitleProviderManager();

	// Process movies
	const movieEntries = Array.from(movieMap.values());
	for (let i = 0; i < movieEntries.length; i += MAX_CONCURRENT_SEARCHES) {
		// Check for cancellation between batches
		ctx?.checkCancelled();

		// Re-check provider availability each batch (Bazarr pattern: break when all throttled)
		const currentProviders = await providerManager.getEnabledProviders();
		if (currentProviders.length === 0) {
			logger.warn(
				'[SubtitleUpgradeTask] All providers throttled or disabled mid-run, stopping movie upgrade search'
			);
			break;
		}

		const batch = movieEntries.slice(i, i + MAX_CONCURRENT_SEARCHES);

		await Promise.all(
			batch.map(async ({ movie, subtitles: movieSubs }) => {
				const isMonitored = await isMovieMonitored({ movie });
				if (!isMonitored) return;

				let movieUpgraded = 0;
				let movieError: string | undefined;
				let oldScore: number | undefined;
				let newScore: number | undefined;

				try {
					// Effective requirements (movie override → library → instance
					// default); upgrades need the policy profile.
					const effective = await profileService.getEffectiveSubtitleRequirements({
						movieId: movie.id
					});
					const profile = effective?.profile;
					const requirements = effective?.requirements ?? [];
					if (!profile || !profile.upgradesAllowed || requirements.length === 0) {
						return;
					}

					processed++;

					const languages = [...new Set(requirements.map((l) => l.tag))];
					if (languages.length === 0) return;

					// Search for subtitles. Gate providers that cannot verify HI when
					// the requirements include HI; otherwise an upgrade candidate could
					// not verify the accessibility of the subtitle it replaces.
					const requireHearingImpaired = requirements.some((r) => r.accessibility === 'require-hi');
					const results = await searchService.searchForMovie(movie.id, languages, {
						requireHearingImpaired
					});

					// Check each existing subtitle for upgrades
					for (const existingSub of movieSubs) {
						const requirement = requirementForSubtitle(requirements, existingSub);
						if (!requirement) continue;

						// Upgrade attempts share the per-requirement backoff gate:
						// a provider outage must not be retried for the whole
						// capped set on every run.
						const eligible = await filterSearchEligible('movie', movie.id, [requirement]);
						if (eligible.length === 0) continue;

						const currentScore = existingSub.matchScore ?? 0;

						// Tuple-valid candidates only, then require a real improvement.
						const candidates = selectCandidates(results.results, requirement, 0);
						const betterMatch = candidates.find(
							(candidate) => candidate.matchScore > currentScore + MIN_SCORE_IMPROVEMENT
						);

						if (betterMatch) {
							try {
								oldScore = currentScore;
								newScore = betterMatch.matchScore;
								// Target the same movie file the existing subtitle is linked to
								// so the service replaces that row (and records it as an upgrade)
								// instead of inserting a second row for an ambiguous multi-file movie.
								await downloadService.downloadForMovie(movie.id, betterMatch, {
									movieFileId: existingSub.movieFileId ?? undefined
								});
								upgraded++;
								movieUpgraded++;
								await resetSearchFailure('movie', movie.id, requirementKey(requirement));

								// History is owned by SubtitleDownloadService (single write,
								// including replacedSubtitleId).
								const normalizedLanguage = normalizeLanguageCode(betterMatch.language);

								logger.info(
									{
										movieId: movie.id,
										language: normalizedLanguage,
										oldScore,
										newScore: betterMatch.matchScore
									},
									'[SubtitleUpgradeTask] Upgraded movie subtitle'
								);
							} catch (downloadError) {
								errorCount++;
								movieError =
									downloadError instanceof Error ? downloadError.message : String(downloadError);
								await recordSearchFailure('movie', movie.id, requirementKey(requirement));
								logger.warn(
									{
										movieId: movie.id,
										language: normalizeLanguageCode(existingSub.language),
										error: movieError
									},
									'[SubtitleUpgradeTask] Failed to download upgraded subtitle'
								);
							}
						} else {
							// No better candidate yet: back off this requirement so
							// upgrade checks do not hammer providers every run.
							await recordSearchFailure('movie', movie.id, requirementKey(requirement));
						}
					}

					// Record to monitoring history for activity tracking
					await db.insert(monitoringHistory).values({
						taskHistoryId,
						taskType: 'subtitleUpgrade',
						movieId: movie.id,
						status: movieUpgraded > 0 ? 'grabbed' : movieError ? 'error' : 'no_results',
						releasesFound: movieSubs.length, // Number of existing subtitles evaluated
						releaseGrabbed: movieUpgraded > 0 ? `${movieUpgraded} upgrade(s)` : undefined,
						isUpgrade: true,
						oldScore,
						newScore,
						errorMessage: movieError,
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
						'[SubtitleUpgradeTask] Error processing movie subtitles'
					);

					// Record error to monitoring history
					await db.insert(monitoringHistory).values({
						taskHistoryId,
						taskType: 'subtitleUpgrade',
						movieId: movie.id,
						status: 'error',
						releasesFound: 0,
						isUpgrade: true,
						errorMessage: errorMsg,
						executedAt: executedAt.toISOString()
					});
				}
			})
		);
	}

	return { processed, upgraded, errors: errorCount };
}

/**
 * Search for subtitle upgrades on episodes
 */
async function searchEpisodeSubtitleUpgrades(
	searchService: ReturnType<typeof getSubtitleSearchService>,
	downloadService: ReturnType<typeof getSubtitleDownloadService>,
	profileService: LanguageProfileService,
	executedAt: Date,
	taskHistoryId?: string,
	ctx?: TaskExecutionContext | null
): Promise<{ processed: number; upgraded: number; errors: number }> {
	let processed = 0;
	let upgraded = 0;
	let errorCount = 0;

	// Get episode subtitles with scores, oldest-checked first. The series join
	// enforces the preflight so unmonitored/opted-out rows are never scanned.
	const episodeSubtitles = await db
		.select({
			subtitle: subtitles,
			episode: episodes,
			series: series
		})
		.from(subtitles)
		.innerJoin(episodes, eq(subtitles.episodeId, episodes.id))
		.innerJoin(series, eq(episodes.seriesId, series.id))
		.where(
			and(
				isNotNull(subtitles.episodeId),
				isNotNull(subtitles.matchScore),
				eq(episodes.monitored, true),
				eq(episodes.hasFile, true),
				// Tri-state subtitle gate: the episode override wins when set
				// (true forces subtitles on against a series-level opt-out);
				// otherwise the series flag applies.
				or(
					and(isNull(episodes.wantsSubtitlesOverride), eq(series.wantsSubtitles, true)),
					eq(episodes.wantsSubtitlesOverride, true)
				),
				eq(series.monitored, true)
			)
		)
		.orderBy(asc(subtitles.lastCheckedAt), asc(subtitles.id))
		.limit(MAX_SUBTITLES_PER_RUN);

	logger.debug(
		{
			count: episodeSubtitles.length
		},
		'[SubtitleUpgradeTask] Found episode subtitles to evaluate'
	);

	// Rotation advances for every row examined, upgrade or not.
	await markSubtitlesChecked(
		episodeSubtitles.map((row) => row.subtitle.id),
		executedAt.toISOString()
	);

	// Group by episode
	const episodeMap = new Map<
		string,
		{ episode: typeof episodes.$inferSelect; subtitles: (typeof subtitles.$inferSelect)[] }
	>();

	for (const row of episodeSubtitles) {
		const existing = episodeMap.get(row.episode.id);
		if (existing) {
			existing.subtitles.push(row.subtitle);
		} else {
			episodeMap.set(row.episode.id, { episode: row.episode, subtitles: [row.subtitle] });
		}
	}

	// Series rows already joined above (monitored + gate passed).
	const seriesMap = new Map(episodeSubtitles.map((row) => [row.series.id, row.series]));

	// Get provider manager for per-batch health checks
	const providerManager = getSubtitleProviderManager();

	// Process episodes
	const episodeEntries = Array.from(episodeMap.values());
	for (let i = 0; i < episodeEntries.length; i += MAX_CONCURRENT_SEARCHES) {
		// Check for cancellation between batches
		ctx?.checkCancelled();

		// Re-check provider availability each batch (Bazarr pattern: break when all throttled)
		const currentProviders = await providerManager.getEnabledProviders();
		if (currentProviders.length === 0) {
			logger.warn(
				'[SubtitleUpgradeTask] All providers throttled or disabled mid-run, stopping episode upgrade search'
			);
			break;
		}

		const batch = episodeEntries.slice(i, i + MAX_CONCURRENT_SEARCHES);

		await Promise.all(
			batch.map(async ({ episode, subtitles: episodeSubs }) => {
				const seriesRow = seriesMap.get(episode.seriesId);
				if (!seriesRow) return;

				// Tri-state gate (defense in depth — the SQL prefilter enforces it too).
				if ((episode.wantsSubtitlesOverride ?? seriesRow.wantsSubtitles) === false) return;

				let episodeUpgraded = 0;
				let episodeError: string | undefined;
				let oldScore: number | undefined;
				let newScore: number | undefined;

				try {
					if (!episode.monitored || !episode.hasFile) return;

					// Effective requirements (episode override → series override →
					// library → instance default); upgrades need the policy profile.
					const effective = await profileService.getEffectiveSubtitleRequirements({
						episodeId: episode.id
					});
					const profile = effective?.profile;
					const requirements = effective?.requirements ?? [];
					if (!profile || !profile.upgradesAllowed || requirements.length === 0) {
						return;
					}

					processed++;

					const languages = [...new Set(requirements.map((l) => l.tag))];
					if (languages.length === 0) return;

					// Search for subtitles. Gate providers that cannot verify HI when
					// the requirements include HI; otherwise an upgrade candidate could
					// not verify the accessibility of the subtitle it replaces.
					const requireHearingImpaired = requirements.some((r) => r.accessibility === 'require-hi');
					const results = await searchService.searchForEpisode(episode.id, languages, {
						requireHearingImpaired
					});

					// Check each existing subtitle for upgrades
					for (const existingSub of episodeSubs) {
						const requirement = requirementForSubtitle(requirements, existingSub);
						if (!requirement) continue;

						// Same per-requirement backoff gate as movies.
						const eligible = await filterSearchEligible('episode', episode.id, [requirement]);
						if (eligible.length === 0) continue;

						const currentScore = existingSub.matchScore ?? 0;

						// Tuple-valid candidates only, then require a real improvement.
						const candidates = selectCandidates(results.results, requirement, 0);
						const betterMatch = candidates.find(
							(candidate) => candidate.matchScore > currentScore + MIN_SCORE_IMPROVEMENT
						);

						if (betterMatch) {
							try {
								oldScore = currentScore;
								newScore = betterMatch.matchScore;
								await downloadService.downloadForEpisode(episode.id, betterMatch);
								upgraded++;
								episodeUpgraded++;
								await resetSearchFailure('episode', episode.id, requirementKey(requirement));

								// History is owned by SubtitleDownloadService (single write,
								// including replacedSubtitleId).
								const normalizedLanguage = normalizeLanguageCode(betterMatch.language);

								logger.info(
									{
										episodeId: episode.id,
										language: normalizedLanguage,
										oldScore,
										newScore: betterMatch.matchScore
									},
									'[SubtitleUpgradeTask] Upgraded episode subtitle'
								);
							} catch (downloadError) {
								errorCount++;
								episodeError =
									downloadError instanceof Error ? downloadError.message : String(downloadError);
								await recordSearchFailure('episode', episode.id, requirementKey(requirement));
								logger.warn(
									{
										episodeId: episode.id,
										language: normalizeLanguageCode(existingSub.language),
										error: episodeError
									},
									'[SubtitleUpgradeTask] Failed to download upgraded subtitle'
								);
							}
						} else {
							await recordSearchFailure('episode', episode.id, requirementKey(requirement));
						}
					}

					// Record to monitoring history for activity tracking
					await db.insert(monitoringHistory).values({
						taskHistoryId,
						taskType: 'subtitleUpgrade',
						episodeId: episode.id,
						seriesId: episode.seriesId,
						status: episodeUpgraded > 0 ? 'grabbed' : episodeError ? 'error' : 'no_results',
						releasesFound: episodeSubs.length, // Number of existing subtitles evaluated
						releaseGrabbed: episodeUpgraded > 0 ? `${episodeUpgraded} upgrade(s)` : undefined,
						isUpgrade: true,
						oldScore,
						newScore,
						errorMessage: episodeError,
						executedAt: executedAt.toISOString()
					});
				} catch (error) {
					errorCount++;
					const errorMsg = error instanceof Error ? error.message : String(error);
					logger.warn(
						{
							episodeId: episode.id,
							error: errorMsg
						},
						'[SubtitleUpgradeTask] Error processing episode subtitles'
					);

					// Record error to monitoring history
					await db.insert(monitoringHistory).values({
						taskHistoryId,
						taskType: 'subtitleUpgrade',
						episodeId: episode.id,
						seriesId: episode.seriesId,
						status: 'error',
						releasesFound: 0,
						isUpgrade: true,
						errorMessage: errorMsg,
						executedAt: executedAt.toISOString()
					});
				}
			})
		);
	}

	return { processed, upgraded, errors: errorCount };
}

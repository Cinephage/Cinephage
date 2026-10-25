import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { movieFiles, movies, scoringProfiles } from '#lib/server/db/schema.js';
import { grabService } from '#lib/server/downloads/GrabService.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { evaluateIndexerSearchAvailability } from '#lib/server/indexers/search/availability.js';
import {
	effectiveBuckets,
	getFilledResolutions,
	unfilledBuckets,
	isMultiQualityMode
} from '#lib/server/quality/buckets.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import type { SearchCriteria, EnhancedReleaseResult } from '#lib/server/indexers/types/index.js';
import { AUTO_GRAB_MIN_SCORE } from './search-utils.js';
import type { AltTitleRefresher } from './alt-titles.js';
import type { SearchForMovieParams, GrabResult } from './types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchMovie', logDomain: 'scans' });

/**
 * Build and send a grab request for a single movie release. Shared by the
 * upgrade loop (isUpgrade true) and the bucket-fill loop (isUpgrade false).
 */
function grabRelease(release: EnhancedReleaseResult, movieId: string, isUpgrade: boolean) {
	return grabService.grab({
		release: {
			title: release.title,
			infoHash: release.infoHash,
			magnetUrl: release.magnetUrl,
			downloadUrl: release.downloadUrl,
			indexerId: release.indexerId,
			indexerName: release.indexerName,
			size: release.size,
			protocol: release.protocol as 'torrent' | 'usenet' | 'streaming' | undefined,
			tmdbId: release.tmdbId,
			imdbId: release.imdbId,
			tvdbId: release.tvdbId
		},
		target: { type: 'movie' as const, movieId },
		options: {
			force: false,
			skipBlocklist: false,
			allowSidegrade: false,
			isAutomatic: true,
			isUpgrade
		}
	});
}

export async function searchForMovie(
	params: SearchForMovieParams,
	altTitles: AltTitleRefresher
): Promise<GrabResult> {
	const { movieId, tmdbId, imdbId, title, year, scoringProfileId, onProgress } = params;

	logger.info({ movieId, tmdbId, title, year }, '[SearchOnAdd] Starting movie search');

	// Report initial progress
	onProgress?.('initializing', `Starting search for "${title}"...`, { current: 0, total: 100 });

	try {
		// Fetch ALL existing files so multi-quality movies can detect which
		// resolution buckets are already filled, not just whether one exists.
		onProgress?.('checking', 'Checking existing files...', { current: 5, total: 100 });

		const files = await db.query.movieFiles.findMany({
			where: eq(movieFiles.movieId, movieId)
		});

		const hasExistingFile = files.length > 0;
		const filledResolutions = getFilledResolutions(files);

		const movieRow = await db.query.movies.findFirst({
			where: eq(movies.id, movieId),
			columns: { desiredQualities: true, scoringProfileId: true }
		});
		const profileRow = movieRow?.scoringProfileId
			? await db.query.scoringProfiles.findFirst({
					where: eq(scoringProfiles.id, movieRow.scoringProfileId),
					columns: { minResolution: true, maxResolution: true }
				})
			: null;
		const effective = effectiveBuckets(
			movieRow?.desiredQualities,
			profileRow?.minResolution,
			profileRow?.maxResolution
		);
		const multiQuality = isMultiQualityMode(effective);
		const unfilled = unfilledBuckets(effective, filledResolutions);

		logger.debug(
			{ movieId, hasExistingFile, effective, filledResolutions, multiQuality, unfilled },
			'[SearchOnAdd] Movie file status'
		);

		const indexerManager = await getIndexerManager();
		const searchSource: 'interactive' | 'automatic' = 'automatic';
		const indexerAvailability = evaluateIndexerSearchAvailability(
			await indexerManager.getIndexers(),
			{
				searchType: 'movie',
				searchSource,
				scoringProfileId,
				getDefinitionCapabilities: (definitionId) =>
					indexerManager.getDefinitionCapabilities(definitionId)
			}
		);

		if (!indexerAvailability.ok) {
			const errorMessage = indexerAvailability.message || 'No indexers are available';
			logger.info(
				{
					movieId,
					code: indexerAvailability.code,
					message: errorMessage
				},
				'[SearchOnAdd] Movie search blocked by indexer availability'
			);
			onProgress?.('error', errorMessage, { current: 100, total: 100 });
			return { success: false, error: errorMessage };
		}

		// Build search criteria
		const movieSearchTitles = await altTitles.getMovieSearchTitlesWithRefresh(movieId, tmdbId);
		const criteria: SearchCriteria = {
			searchType: 'movie',
			query: title,
			tmdbId,
			imdbId: imdbId ?? undefined,
			year,
			searchTitles: movieSearchTitles.length > 0 ? movieSearchTitles : [title]
		};

		// Perform enriched search to get scored releases (automatic - on add)
		onProgress?.('searching', 'Querying indexers for releases...', { current: 10, total: 100 });

		const searchResult = await indexerManager.searchEnhanced(criteria, {
			searchSource,
			enrichment: {
				scoringProfileId,
				filterRejected: true,
				minScore: AUTO_GRAB_MIN_SCORE
			}
		});

		logger.info(
			{
				movieId,
				totalResults: searchResult.releases.length,
				rejectedCount: searchResult.rejectedCount
			},
			'[SearchOnAdd] Movie search completed'
		);

		// Log the top releases for debugging
		if (searchResult.releases.length > 0) {
			const topReleases = searchResult.releases.slice(0, 5).map((r) => ({
				title: r.title,
				totalScore: r.totalScore,
				resolution: r.parsed.resolution,
				source: r.parsed.source,
				codec: r.parsed.codec,
				size: r.size ? Math.round((r.size / 1024 / 1024 / 1024) * 10) / 10 + 'GB' : 'unknown'
			}));
			logger.info({ movieId, topReleases }, '[SearchOnAdd] Top 5 releases by score');
		}

		if (searchResult.releases.length === 0) {
			logger.info({ movieId, title }, '[SearchOnAdd] No suitable releases found for movie');
			onProgress?.('complete', 'No suitable releases found', { current: 100, total: 100 });
			return { success: false, error: 'No suitable releases found' };
		}

		onProgress?.('evaluating', `Found ${searchResult.releases.length} releases, evaluating...`, {
			current: 50,
			total: 100
		});

		// Route: multi-quality movies with empty buckets fill them as fresh grabs;
		// otherwise a movie with an existing file looks for upgrades only; a fresh
		// single-quality movie grabs the single best release.
		const needsBucketFill = multiQuality && unfilled.length > 0;

		if (hasExistingFile && !needsBucketFill) {
			logger.info({ movieId }, '[SearchOnAdd] Movie has existing file, checking for upgrades');
			onProgress?.('evaluating', 'Checking for upgrade releases...', { current: 60, total: 100 });

			for (const release of searchResult.releases) {
				onProgress?.('grabbing', `Grabbing: ${release.title.substring(0, 50)}...`, {
					current: 85,
					total: 100
				});

				const grabResult = await grabRelease(release, movieId, true);

				if (grabResult.success) {
					onProgress?.('complete', `\u2713 Grabbed: ${release.title}`, {
						current: 100,
						total: 100
					});

					return {
						success: true,
						releaseName: release.title,
						queueItemId: grabResult.download?.queueId
					};
				}

				const grabError = grabResult.error ?? grabResult.decision?.reason ?? 'Unknown error';
				logger.info(
					{ movieId, title: release.title, error: grabError },
					'[SearchOnAdd] Release not grabbed — trying next'
				);
			}

			logger.info({ movieId }, '[SearchOnAdd] No upgrades found for movie with existing file');
			onProgress?.('complete', 'No upgrades found - existing file quality is sufficient', {
				current: 100,
				total: 100
			});
			return { success: false, error: 'No upgrades found - existing file quality is sufficient' };
		}

		// Fill empty buckets (multi-quality) or grab the single best release
		// (fresh single-quality). One release per desired bucket; resolutions
		// outside the effective buckets are skipped.
		if (needsBucketFill) {
			logger.info(
				{ movieId, effective, filledResolutions, unfilled },
				'[SearchOnAdd] Filling empty multi-quality buckets'
			);
		}

		const alreadyGrabbed: Resolution[] = multiQuality
			? effective.filter((r) => filledResolutions.includes(r))
			: [];
		let lastGrab: GrabResult | null = null;

		for (const release of searchResult.releases) {
			const res = release.parsed?.resolution as Resolution | undefined;
			if (multiQuality && (!res || !effective.includes(res) || alreadyGrabbed.includes(res))) {
				continue;
			}

			onProgress?.('grabbing', `Grabbing: ${release.title.substring(0, 50)}...`, {
				current: 85,
				total: 100
			});

			const grabResult = await grabRelease(release, movieId, false);

			if (grabResult.success) {
				if (multiQuality && res) alreadyGrabbed.push(res);
				lastGrab = {
					success: true,
					releaseName: release.title,
					queueItemId: grabResult.download?.queueId
				};
				// In single-quality mode, one grab is enough.
				if (!multiQuality) break;
				// In multi-quality mode, keep going until all buckets are filled.
				if (alreadyGrabbed.length >= effective.length) break;
				continue;
			}

			lastGrab = {
				success: false,
				error: grabResult.error ?? grabResult.decision?.reason ?? 'Unknown error'
			};
			if (!multiQuality) break;
		}

		if (lastGrab?.success) {
			onProgress?.('complete', `\u2713 Grabbed: ${lastGrab.releaseName}`, {
				current: 100,
				total: 100
			});
		} else {
			onProgress?.('complete', 'No suitable releases found', {
				current: 100,
				total: 100
			});
		}

		return lastGrab ?? { success: false, error: 'No releases found' };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ movieId, err: error }, '[SearchOnAdd] Movie search failed');
		onProgress?.('error', `Search failed: ${message}`, { current: 100, total: 100 });
		return { success: false, error: message };
	}
}

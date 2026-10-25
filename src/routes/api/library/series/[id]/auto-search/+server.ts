import type { RequestHandler } from './$types.js';
import { searchOnAdd } from '#lib/server/library/searchOnAdd.js';
import { createSSEOperationStream } from '#lib/server/sse.js';
import {
	startSearch,
	stopSearch,
	isSeriesSearching,
	updateSearchProgress
} from '#lib/server/library/ActiveSearchTracker.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { SearchProgressUpdate } from '#lib/server/downloads/MultiSeasonSearchStrategy.js';
import { collectAutoSearchIssues } from '#lib/server/library/autoSearchIssues.js';
import { getAutoSearchPreflightIssue } from '#lib/server/library/autoSearchPreflight.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeriesAutoSearchApi', logDomain: 'scans' });

/**
 * Auto-Search Request Types
 */
interface AutoSearchRequest {
	type: 'episode' | 'season' | 'missing' | 'bulk';
	episodeId?: string; // For single episode search
	seasonNumber?: number; // For season pack search
	episodeIds?: string[]; // For bulk episode selection
}

/**
 * POST /api/library/series/[id]/auto-search
 * Automatically search and grab releases for episodes/seasons
 * Returns SSE stream for real-time progress updates
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const seriesId = params.id;

		// Verify series exists
		const seriesData = await db.query.series.findFirst({
			where: eq(series.id, seriesId)
		});

		if (!seriesData) {
			return new Response(JSON.stringify({ success: false, error: 'Series not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Check if a search is already running for this series
		if (isSeriesSearching(seriesId)) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'A search is already in progress for this series'
				}),
				{ status: 409, headers: { 'Content-Type': 'application/json' } }
			);
		}

		const body: AutoSearchRequest = await request.json();
		const { type, episodeId, seasonNumber, episodeIds } = body;

		return createSSEOperationStream(
			request,
			async ({ send, close, isAborted }) => {
				const sendEvent = (event: string, data: unknown) => {
					if (isAborted()) return;
					send(event, data);
				};

				// Track search in active searches
				let searchId: string;
				let trackerType: 'single' | 'missing' | 'bulk';

				switch (type) {
					case 'episode':
					case 'season': {
						searchId =
							type === 'episode'
								? `series-${seriesId}-episode-${episodeId}`
								: `series-${seriesId}-season-${seasonNumber}`;
						trackerType = 'single';
						break;
					}
					case 'missing': {
						searchId = `series-${seriesId}-missing`;
						trackerType = 'missing';
						break;
					}
					case 'bulk': {
						searchId = `series-${seriesId}-bulk-${Date.now()}`;
						trackerType = 'bulk';
						break;
					}
					default: {
						sendEvent('search:error', {
							success: false,
							error: `Invalid search type: ${type}`
						});
						close();
						return;
					}
				}

				startSearch(searchId, { seriesId, type: trackerType });
				libraryMediaEvents.emit('series:searchStarted', { seriesId, searchType: type });

				// Send initial event
				sendEvent('search:started', {
					seriesId,
					searchType: type,
					phase: 'initializing'
				});

				// Set up progress callback for multi-season searches
				const onProgress = (update: SearchProgressUpdate) => {
					// Update active search progress
					updateSearchProgress(searchId, {
						currentPhase: update.phase,
						percentComplete: update.percentComplete,
						currentItem: update.message
					});

					// Emit to global event bus
					libraryMediaEvents.emitSearchProgress({
						searchId,
						seriesId,
						phase: update.phase,
						message: update.message,
						details: update.details
					});

					// Send SSE event
					sendEvent('search:progress', update);
				};

				try {
					const preflightIssue = await getAutoSearchPreflightIssue(
						seriesData.scoringProfileId,
						'tv'
					);
					if (preflightIssue) {
						sendEvent('search:completed', {
							success: false,
							results: [],
							summary: {
								searched: 0,
								found: 0,
								grabbed: 0
							},
							error: preflightIssue.message,
							issues: [preflightIssue]
						});
						return;
					}

					switch (type) {
						case 'episode': {
							if (!episodeId) {
								sendEvent('search:error', {
									success: false,
									error: 'episodeId is required for episode search'
								});
								return;
							}

							const result = await searchOnAdd.searchForEpisode({
								episodeId,
								bypassMonitoring: true
							});
							const issues = collectAutoSearchIssues([result.error]);

							sendEvent('search:completed', {
								success: result.success,
								results: [
									{
										itemId: episodeId,
										itemLabel: 'Episode',
										found: result.success,
										grabbed: result.success,
										releaseName: result.releaseName,
										error: result.error
									}
								],
								issues: issues.length > 0 ? issues : undefined,
								summary: {
									searched: 1,
									found: result.success ? 1 : 0,
									grabbed: result.success ? 1 : 0
								}
							});
							break;
						}

						case 'season': {
							if (seasonNumber === undefined) {
								sendEvent('search:error', {
									success: false,
									error: 'seasonNumber is required for season search'
								});
								return;
							}

							const result = await searchOnAdd.searchForSeason({
								seriesId,
								seasonNumber,
								bypassMonitoring: true
							});
							const issues = collectAutoSearchIssues([result.error]);

							sendEvent('search:completed', {
								success: result.success,
								results: [
									{
										itemId: `${seriesId}-s${seasonNumber}`,
										itemLabel: `Season ${seasonNumber}`,
										found: result.success,
										grabbed: result.success,
										releaseName: result.releaseName,
										error: result.error
									}
								],
								issues: issues.length > 0 ? issues : undefined,
								summary: {
									searched: 1,
									found: result.success ? 1 : 0,
									grabbed: result.success ? 1 : 0
								}
							});
							break;
						}

						case 'missing': {
							const result = await searchOnAdd.searchForMissingEpisodes(seriesId, onProgress, {
								bypassMonitoring: true,
								// RuTracker-only setups use episode-only workflow.
								// Mixed/non-RuTracker setups stay on pack-first behavior.
								searchStrategy: 'auto',
								searchSource: 'interactive'
							});
							const itemErrors = result.results.map((item) => item.error);
							const issues = collectAutoSearchIssues([
								result.error,
								...(result.errors ?? []),
								...itemErrors
							]);

							sendEvent('search:completed', {
								success: !result.error,
								results: result.results,
								summary: result.summary,
								seasonPacks: result.seasonPacks,
								errors: result.errors,
								issues: issues.length > 0 ? issues : undefined,
								error: result.error
							});
							break;
						}

						case 'bulk': {
							if (!episodeIds || episodeIds.length === 0) {
								sendEvent('search:error', {
									success: false,
									error: 'episodeIds is required for bulk search'
								});
								return;
							}

							const result = await searchOnAdd.searchBulkEpisodes(episodeIds, onProgress);
							const itemErrors = result.results.map((item) => item.error);
							const issues = collectAutoSearchIssues([
								result.error,
								...(result.errors ?? []),
								...itemErrors
							]);

							sendEvent('search:completed', {
								success: !result.error,
								results: result.results,
								summary: result.summary,
								seasonPacks: result.seasonPacks,
								errors: result.errors,
								issues: issues.length > 0 ? issues : undefined,
								error: result.error
							});
							break;
						}
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Failed to perform auto-search';
					logger.error('[API] Auto-search error', error instanceof Error ? error : undefined);
					sendEvent('search:error', {
						success: false,
						error: message
					});
				} finally {
					stopSearch(searchId);
					libraryMediaEvents.emit('series:searchCompleted', { seriesId, searchType: type });
				}
			},
			{ heartbeatInterval: 25000 }
		);
	} catch (error) {
		logger.error('[API] Auto-search error', error instanceof Error ? error : undefined);
		return new Response(
			JSON.stringify({
				success: false,
				error: error instanceof Error ? error.message : 'Failed to perform auto-search'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};

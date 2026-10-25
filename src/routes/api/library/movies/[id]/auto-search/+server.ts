import type { RequestHandler } from './$types.js';
import { searchOnAdd } from '#lib/server/library/searchOnAdd.js';
import { createSSEOperationStream } from '#lib/server/sse.js';
import {
	startSearch,
	stopSearch,
	isMovieSearching,
	updateSearchProgress
} from '#lib/server/library/ActiveSearchTracker.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { db } from '#lib/server/db/index.js';
import { movies } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { collectAutoSearchIssues } from '#lib/server/library/autoSearchIssues.js';
import { getAutoSearchPreflightIssue } from '#lib/server/library/autoSearchPreflight.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMovieAutoSearchApi', logDomain: 'scans' });

/**
 * POST /api/library/movies/[id]/auto-search
 * Automatically search and grab the best release for a movie
 * Returns SSE stream for real-time progress updates
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const movieId = params.id;

		// Verify movie exists and get details
		const movie = await db.query.movies.findFirst({
			where: eq(movies.id, movieId)
		});

		if (!movie) {
			return new Response(JSON.stringify({ success: false, error: 'Movie not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Check if a search is already running for this movie
		if (isMovieSearching(movieId)) {
			return new Response(
				JSON.stringify({ success: false, error: 'A search is already in progress for this movie' }),
				{ status: 409, headers: { 'Content-Type': 'application/json' } }
			);
		}

		logger.info(
			{
				movieId,
				title: movie.title
			},
			'[API] Auto-search triggered for movie'
		);

		// Track search in active searches
		const searchId = `movie-${movieId}`;
		startSearch(searchId, { movieId, type: 'single' });
		libraryMediaEvents.emit('movie:searchStarted', { movieId });

		return createSSEOperationStream(
			request,
			async ({ send, isAborted }) => {
				const sendEvent = (event: string, data: unknown) => {
					if (isAborted()) return;
					send(event, data);
				};

				sendEvent('search:started', {
					movieId,
					title: movie.title,
					phase: 'initializing'
				});

				try {
					const preflightIssue = await getAutoSearchPreflightIssue(movie.scoringProfileId, 'movie');
					if (preflightIssue) {
						sendEvent('search:completed', {
							success: false,
							found: false,
							grabbed: false,
							error: preflightIssue.message,
							issues: [preflightIssue]
						});
						return;
					}

					// Set up progress callback
					const onProgress = (
						phase: string,
						message: string,
						progress?: { current: number; total: number }
					) => {
						// Update active search progress
						updateSearchProgress(searchId, {
							currentPhase: phase,
							percentComplete: progress ? Math.round((progress.current / progress.total) * 100) : 0,
							currentItem: message
						});

						// Emit to global event bus
						libraryMediaEvents.emitSearchProgress({
							searchId,
							movieId,
							phase: phase as 'searching' | 'evaluating' | 'grabbing' | 'complete' | 'error',
							message,
							progress
						});

						// Send SSE event
						sendEvent('search:progress', {
							phase,
							message,
							progress
						});
					};

					// Use searchOnAdd service to search and grab
					const result = await searchOnAdd.searchForMovie({
						movieId,
						tmdbId: movie.tmdbId,
						imdbId: movie.imdbId,
						title: movie.title,
						year: movie.year ?? undefined,
						scoringProfileId: movie.scoringProfileId ?? undefined,
						bypassMonitoring: true,
						onProgress
					});

					logger.info(
						{
							movieId,
							title: movie.title,
							success: result.success,
							releaseName: result.releaseName,
							error: result.error
						},
						'[API] Auto-search completed for movie'
					);
					const issues = collectAutoSearchIssues([result.error]);

					// Send completion event
					sendEvent('search:completed', {
						success: result.success,
						found: result.success && !!result.releaseName,
						grabbed: result.success && !!result.releaseName,
						releaseName: result.releaseName,
						queueItemId: result.queueItemId,
						issues: issues.length > 0 ? issues : undefined,
						error: result.error
					});

					// Emit to global event bus
					libraryMediaEvents.emitSearchCompleted({
						searchId,
						movieId,
						success: result.success,
						results: {
							totalSearched: 1,
							totalFound: result.success && !!result.releaseName ? 1 : 0,
							totalGrabbed: result.success && !!result.releaseName ? 1 : 0,
							completeSeriesPacksGrabbed: 0,
							multiSeasonPacksGrabbed: 0,
							singleSeasonPacksGrabbed: 0,
							individualEpisodesGrabbed: 0,
							packsGrabbed: [],
							episodesGrabbed:
								result.success && !!result.releaseName
									? [
											{
												episodeId: movieId,
												label: movie.title,
												releaseName: result.releaseName || '',
												wasPackGrab: false
											}
										]
									: [],
							notFound: result.success && !!result.releaseName ? [] : [movieId],
							errors: result.error ? [result.error] : []
						}
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					logger.error('[API] Movie auto-search error', error instanceof Error ? error : undefined);

					// Send error event
					sendEvent('search:error', {
						success: false,
						error: message
					});
				} finally {
					stopSearch(searchId);
					libraryMediaEvents.emit('movie:searchCompleted', { movieId });
				}
			},
			{ heartbeatInterval: 25000 }
		);
	} catch (error) {
		logger.error('[API] Movie auto-search error', error instanceof Error ? error : undefined);
		return new Response(
			JSON.stringify({
				success: false,
				error: error instanceof Error ? error.message : 'Failed to perform auto-search'
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
};

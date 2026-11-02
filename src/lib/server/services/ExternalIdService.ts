/**
 * External ID Service
 *
 * Background service that ensures all movies and TV series have
 * external IDs (IMDB, TVDB) populated from TMDB.
 *
 * Runs periodically to:
 * 1. Find media with missing external IDs
 * 2. Fetch IDs from TMDB API
 * 3. Update database records
 *
 * This ensures indexer searches and subtitle providers work correctly.
 */

import type { BackgroundService, ServiceStatus } from './background-service.js';
import { db } from '#lib/server/db/index.js';
import { movies, series } from '#lib/server/db/schema.js';
import { isNull, or } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'ExternalIdService', logDomain: 'system' });

/**
 * Configuration for the external ID service
 */
interface ExternalIdServiceConfig {
	/** How often to run the scan in hours (default: 6) */
	intervalHours: number;
	/** Maximum items to process per run (default: 50) */
	batchSize: number;
	/** Delay between TMDB API calls in ms (default: 250) */
	apiDelayMs: number;
	/** Whether to run immediately on startup (default: true) */
	runOnStartup: boolean;
}

const DEFAULT_CONFIG: ExternalIdServiceConfig = {
	intervalHours: 6,
	batchSize: 50,
	apiDelayMs: 250,
	runOnStartup: process.env.EXTERNAL_ID_RUN_ON_STARTUP !== 'false'
};

/**
 * Result from a single external ID refresh
 */
interface RefreshResult {
	id: string;
	title: string;
	mediaType: 'movie' | 'tv';
	tmdbId: number;
	imdbId: string | null;
	tvdbId: number | null;
	success: boolean;
	error?: string;
}

/**
 * Summary of a refresh run
 */
interface RefreshRunSummary {
	moviesProcessed: number;
	moviesUpdated: number;
	seriesProcessed: number;
	seriesUpdated: number;
	errors: number;
	duration: number;
}

/**
 * External ID Service
 *
 * Ensures all media has external IDs populated for proper indexer
 * and subtitle provider functionality.
 */
export class ExternalIdService implements BackgroundService {
	readonly name = 'ExternalIdService';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private config: ExternalIdServiceConfig;
	private intervalTimer: NodeJS.Timeout | null = null;
	private isRunning = false;
	private lastRunTime: Date | null = null;
	private lastRunSummary: RefreshRunSummary | null = null;

	constructor(config: Partial<ExternalIdServiceConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	/**
	 * Start the service (non-blocking)
	 */
	start(): void {
		if (this._status === 'ready' || this._status === 'starting') {
			return;
		}

		this._status = 'starting';
		logger.info({ config: this.config }, `[${this.name}] Starting...`);

		// Use setImmediate to not block
		setImmediate(() => {
			this.initialize().catch((err) => {
				this._error = err instanceof Error ? err : new Error(String(err));
				this._status = 'error';
				logger.error({ err: this._error }, `[${this.name}] Failed to initialize`);
			});
		});
	}

	/**
	 * Stop the service gracefully
	 */
	async stop(): Promise<void> {
		logger.info(`[${this.name}] Stopping...`);

		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}

		this._status = 'pending';
		logger.info(`[${this.name}] Stopped`);
	}

	/**
	 * Initialize the service
	 */
	private async initialize(): Promise<void> {
		// Set up periodic runs
		const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
		this.intervalTimer = setInterval(() => {
			this.runRefresh().catch((err) => {
				logger.error({ err }, `[${this.name}] Scheduled refresh failed`);
			});
		}, intervalMs);

		this._status = 'ready';
		logger.info(`[${this.name}] Ready. Interval: ${this.config.intervalHours}h`);

		// Run immediately on startup if configured
		if (this.config.runOnStartup) {
			// Small delay to let other services start
			setTimeout(() => {
				this.runRefresh().catch((err) => {
					logger.error({ err }, `[${this.name}] Startup refresh failed`);
				});
			}, 5000);
		}
	}

	/**
	 * Get the current status info
	 */
	getStatusInfo(): {
		status: ServiceStatus;
		lastRunTime: Date | null;
		lastRunSummary: RefreshRunSummary | null;
		isRunning: boolean;
		nextRunTime: Date | null;
	} {
		let nextRunTime: Date | null = null;
		if (this.lastRunTime && this._status === 'ready') {
			nextRunTime = new Date(
				this.lastRunTime.getTime() + this.config.intervalHours * 60 * 60 * 1000
			);
		}

		return {
			status: this._status,
			lastRunTime: this.lastRunTime,
			lastRunSummary: this.lastRunSummary,
			isRunning: this.isRunning,
			nextRunTime
		};
	}

	/**
	 * Manually trigger a refresh run
	 */
	async triggerRefresh(): Promise<RefreshRunSummary> {
		return this.runRefresh();
	}

	/**
	 * Run the external ID refresh process
	 */
	private async runRefresh(): Promise<RefreshRunSummary> {
		if (this.isRunning) {
			logger.warn(`[${this.name}] Refresh already in progress, skipping`);
			return (
				this.lastRunSummary || {
					moviesProcessed: 0,
					moviesUpdated: 0,
					seriesProcessed: 0,
					seriesUpdated: 0,
					errors: 0,
					duration: 0
				}
			);
		}

		this.isRunning = true;
		const startTime = Date.now();
		logger.info(`[${this.name}] Starting refresh run...`);

		const summary: RefreshRunSummary = {
			moviesProcessed: 0,
			moviesUpdated: 0,
			seriesProcessed: 0,
			seriesUpdated: 0,
			errors: 0,
			duration: 0
		};

		try {
			// Process movies with missing external IDs
			const movieResults = await this.refreshMovies();
			summary.moviesProcessed = movieResults.length;
			summary.moviesUpdated = movieResults.filter((r) => r.success && r.imdbId).length;
			summary.errors += movieResults.filter((r) => !r.success).length;

			// Process series with missing external IDs
			const seriesResults = await this.refreshSeries();
			summary.seriesProcessed = seriesResults.length;
			summary.seriesUpdated = seriesResults.filter(
				(r) => r.success && (r.imdbId || r.tvdbId)
			).length;
			summary.errors += seriesResults.filter((r) => !r.success).length;

			summary.duration = Date.now() - startTime;
			this.lastRunTime = new Date();
			this.lastRunSummary = summary;

			logger.info(
				{
					moviesProcessed: summary.moviesProcessed,
					moviesUpdated: summary.moviesUpdated,
					seriesProcessed: summary.seriesProcessed,
					seriesUpdated: summary.seriesUpdated,
					errors: summary.errors,
					durationMs: summary.duration
				},
				`[${this.name}] Refresh complete`
			);

			return summary;
		} catch (error) {
			summary.errors++;
			summary.duration = Date.now() - startTime;
			logger.error({ err: error }, `[${this.name}] Refresh failed`);
			throw error;
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Refresh external IDs for movies with missing IDs
	 */
	private async refreshMovies(): Promise<RefreshResult[]> {
		// Find movies with missing IMDB ID
		const moviesWithMissingIds = await db
			.select({
				id: movies.id,
				tmdbId: movies.tmdbId,
				imdbId: movies.imdbId,
				title: movies.title
			})
			.from(movies)
			.where(isNull(movies.imdbId))
			.limit(this.config.batchSize);

		if (moviesWithMissingIds.length === 0) {
			logger.debug(`[${this.name}] No movies with missing external IDs`);
			return [];
		}

		logger.info(`[${this.name}] Found ${moviesWithMissingIds.length} movies with missing IDs`);

		const results: RefreshResult[] = [];

		for (const movie of moviesWithMissingIds) {
			const result = await this.refreshMovieExternalIds(movie);
			results.push(result);

			// Rate limit API calls
			await this.delay(this.config.apiDelayMs);
		}

		return results;
	}

	/**
	 * Refresh external IDs for a single movie
	 */
	private async refreshMovieExternalIds(movie: {
		id: string;
		tmdbId: number;
		imdbId: string | null;
		title: string;
	}): Promise<RefreshResult> {
		try {
			const externalIds = await tmdb.getMovieExternalIds(movie.tmdbId);

			// Update if we got an IMDB ID
			if (externalIds.imdb_id) {
				const { eq } = await import('drizzle-orm');
				await db.update(movies).set({ imdbId: externalIds.imdb_id }).where(eq(movies.id, movie.id));

				logger.debug(
					{
						id: movie.id,
						title: movie.title,
						imdbId: externalIds.imdb_id
					},
					`[${this.name}] Updated movie external IDs`
				);
			}

			return {
				id: movie.id,
				title: movie.title,
				mediaType: 'movie',
				tmdbId: movie.tmdbId,
				imdbId: externalIds.imdb_id,
				tvdbId: null,
				success: true
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isNotFound = /resource you requested could not be found/i.test(message);

			if (isNotFound) {
				const { eq } = await import('drizzle-orm');
				await db.update(movies).set({ imdbId: '' }).where(eq(movies.id, movie.id));
				logger.info(
					{ id: movie.id, title: movie.title, tmdbId: movie.tmdbId },
					`[${this.name}] TMDB entry not found for movie — marked as no IMDB ID`
				);
			} else {
				logger.warn(
					{ id: movie.id, title: movie.title, err: error },
					`[${this.name}] Failed to fetch external IDs for movie`
				);
			}

			return {
				id: movie.id,
				title: movie.title,
				mediaType: 'movie',
				tmdbId: movie.tmdbId,
				imdbId: null,
				tvdbId: null,
				success: false,
				error: message
			};
		}
	}

	/**
	 * Refresh external IDs for series with missing IDs
	 */
	private async refreshSeries(): Promise<RefreshResult[]> {
		// Find series with missing IMDB or TVDB IDs
		const seriesWithMissingIds = await db
			.select({
				id: series.id,
				tmdbId: series.tmdbId,
				imdbId: series.imdbId,
				tvdbId: series.tvdbId,
				title: series.title
			})
			.from(series)
			.where(or(isNull(series.imdbId), isNull(series.tvdbId)))
			.limit(this.config.batchSize);

		if (seriesWithMissingIds.length === 0) {
			logger.debug(`[${this.name}] No series with missing external IDs`);
			return [];
		}

		logger.info(`[${this.name}] Found ${seriesWithMissingIds.length} series with missing IDs`);

		const results: RefreshResult[] = [];

		for (const show of seriesWithMissingIds) {
			const result = await this.refreshSeriesExternalIds(show);
			results.push(result);

			// Rate limit API calls
			await this.delay(this.config.apiDelayMs);
		}

		return results;
	}

	/**
	 * Refresh external IDs for a single series
	 */
	private async refreshSeriesExternalIds(show: {
		id: string;
		tmdbId: number;
		imdbId: string | null;
		tvdbId: number | null;
		title: string;
	}): Promise<RefreshResult> {
		try {
			const externalIds = await tmdb.getTvExternalIds(show.tmdbId);

			// Build update object with only newly fetched IDs
			const updateData: { imdbId?: string; tvdbId?: number } = {};

			if (!show.imdbId && externalIds.imdb_id) {
				updateData.imdbId = externalIds.imdb_id;
			}
			if (!show.tvdbId && externalIds.tvdb_id) {
				updateData.tvdbId = externalIds.tvdb_id;
			}

			// Update if we got any new IDs
			if (Object.keys(updateData).length > 0) {
				const { eq } = await import('drizzle-orm');
				await db.update(series).set(updateData).where(eq(series.id, show.id));

				logger.debug(
					{
						id: show.id,
						title: show.title,
						imdbId: updateData.imdbId,
						tvdbId: updateData.tvdbId
					},
					`[${this.name}] Updated series external IDs`
				);
			}

			return {
				id: show.id,
				title: show.title,
				mediaType: 'tv',
				tmdbId: show.tmdbId,
				imdbId: externalIds.imdb_id,
				tvdbId: externalIds.tvdb_id,
				success: true
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isNotFound = /resource you requested could not be found/i.test(message);

			if (isNotFound) {
				const { eq } = await import('drizzle-orm');
				await db
					.update(series)
					.set({ imdbId: show.imdbId ?? '', tvdbId: show.tvdbId ?? 0 })
					.where(eq(series.id, show.id));
				logger.info(
					{ id: show.id, title: show.title, tmdbId: show.tmdbId },
					`[${this.name}] TMDB entry not found for series — marked as no external IDs`
				);
			} else {
				logger.warn(
					{ id: show.id, title: show.title, err: error },
					`[${this.name}] Failed to fetch external IDs for series`
				);
			}

			return {
				id: show.id,
				title: show.title,
				mediaType: 'tv',
				tmdbId: show.tmdbId,
				imdbId: null,
				tvdbId: null,
				success: false,
				error: message
			};
		}
	}

	/**
	 * Helper to delay execution (for rate limiting)
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Singleton instance
 */
let externalIdServiceInstance: ExternalIdService | null = null;

export function getExternalIdService(): ExternalIdService {
	if (!externalIdServiceInstance) {
		externalIdServiceInstance = new ExternalIdService();
	}
	return externalIdServiceInstance;
}

/**
 * Helper function to ensure external IDs exist for a media item.
 * Used for on-demand lookups when searching/fetching subtitles.
 *
 * @param mediaType - 'movie' or 'tv'
 * @param id - Database record ID
 * @param tmdbId - TMDB ID for the media
 * @returns The external IDs (possibly freshly fetched)
 */
export async function ensureExternalIds(
	mediaType: 'movie' | 'tv',
	id: string,
	tmdbId: number
): Promise<{ imdbId: string | null; tvdbId: number | null }> {
	const { eq } = await import('drizzle-orm');

	if (mediaType === 'movie') {
		// Check current state
		const [movie] = await db
			.select({ imdbId: movies.imdbId })
			.from(movies)
			.where(eq(movies.id, id))
			.limit(1);

		if (movie?.imdbId) {
			return { imdbId: movie.imdbId, tvdbId: null };
		}

		// Fetch from TMDB
		try {
			const externalIds = await tmdb.getMovieExternalIds(tmdbId);

			if (externalIds.imdb_id) {
				await db.update(movies).set({ imdbId: externalIds.imdb_id }).where(eq(movies.id, id));

				logger.info(
					{
						id,
						imdbId: externalIds.imdb_id
					},
					'[ExternalIdService] On-demand fetch: updated movie external ID'
				);
			}

			return { imdbId: externalIds.imdb_id, tvdbId: null };
		} catch (error) {
			logger.warn(
				{
					id,
					tmdbId,
					err: error
				},
				'[ExternalIdService] On-demand fetch failed for movie'
			);
			return { imdbId: null, tvdbId: null };
		}
	} else {
		// TV series
		const [show] = await db
			.select({ imdbId: series.imdbId, tvdbId: series.tvdbId })
			.from(series)
			.where(eq(series.id, id))
			.limit(1);

		if (show?.imdbId && show?.tvdbId) {
			return { imdbId: show.imdbId, tvdbId: show.tvdbId };
		}

		// Fetch from TMDB
		try {
			const externalIds = await tmdb.getTvExternalIds(tmdbId);

			const updateData: { imdbId?: string; tvdbId?: number } = {};
			if (!show?.imdbId && externalIds.imdb_id) {
				updateData.imdbId = externalIds.imdb_id;
			}
			if (!show?.tvdbId && externalIds.tvdb_id) {
				updateData.tvdbId = externalIds.tvdb_id;
			}

			if (Object.keys(updateData).length > 0) {
				await db.update(series).set(updateData).where(eq(series.id, id));

				logger.info(
					{
						id,
						...updateData
					},
					'[ExternalIdService] On-demand fetch: updated series external IDs'
				);
			}

			return {
				imdbId: externalIds.imdb_id ?? show?.imdbId ?? null,
				tvdbId: externalIds.tvdb_id ?? show?.tvdbId ?? null
			};
		} catch (error) {
			logger.warn(
				{
					id,
					tmdbId,
					err: error
				},
				'[ExternalIdService] On-demand fetch failed for series'
			);
			return {
				imdbId: show?.imdbId ?? null,
				tvdbId: show?.tvdbId ?? null
			};
		}
	}
}

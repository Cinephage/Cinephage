/**
 * Data Repair Service
 *
 * Background service that repairs data issues from previous bugs.
 * Runs once on startup to fix flagged records.
 *
 * Current repairs:
 * - Version 10: Series missing episode metadata (from unmatched endpoint bug)
 */

import type { BackgroundService, ServiceStatus } from './background-service.js';
import { db } from '#lib/server/db/index.js';
import { settings, series, seasons, episodes, episodeFiles } from '#lib/server/db/schema.js';
import { eq, like, and } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';
import { todayDateString } from '#lib/utils/format.js';

const logger = createChildLogger({ module: 'DataRepairService', logDomain: 'system' });

interface RepairSeriesData {
	tmdbId: number;
	title: string;
}

interface RepairResult {
	seriesId: string;
	title: string;
	success: boolean;
	seasonsCreated: number;
	episodesCreated: number;
	episodeFilesLinked: number;
	error?: string;
}

/**
 * Data Repair Service
 *
 * Processes repair flags set by schema migrations and fixes data issues.
 */
export class DataRepairService implements BackgroundService {
	readonly name = 'DataRepairService';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private isRunning = false;

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
		logger.info(`[${this.name}] Starting...`);

		// Use setImmediate to not block
		setImmediate(() => {
			this.runRepairs()
				.then(() => {
					this._status = 'ready';
					logger.info(`[${this.name}] Ready`);
				})
				.catch((err) => {
					this._error = err instanceof Error ? err : new Error(String(err));
					this._status = 'error';
					logger.error({ err: this._error }, `[${this.name}] Failed to run repairs`);
				});
		});
	}

	/**
	 * Stop the service gracefully
	 */
	async stop(): Promise<void> {
		logger.info(`[${this.name}] Stopping...`);
		this._status = 'pending';
		logger.info(`[${this.name}] Stopped`);
	}

	/**
	 * Run all pending repairs
	 */
	private async runRepairs(): Promise<void> {
		await this.repairSeriesEpisodeMetadata();
	}

	/**
	 * Repair series that are missing episode metadata
	 * These were created by the unmatched endpoint bug before it was fixed
	 */
	private async repairSeriesEpisodeMetadata(): Promise<void> {
		// Find all repair_series_* settings
		const repairFlags = await db
			.select()
			.from(settings)
			.where(like(settings.key, 'repair_series_%'));

		if (repairFlags.length === 0) {
			logger.debug(`[${this.name}] No series need episode metadata repair`);
			return;
		}

		logger.info(`[${this.name}] Found ${repairFlags.length} series needing repair`);

		const results: RepairResult[] = [];

		for (const flag of repairFlags) {
			const seriesId = flag.key.replace('repair_series_', '');
			let data: RepairSeriesData;

			try {
				data = JSON.parse(flag.value) as RepairSeriesData;
			} catch {
				logger.error({ key: flag.key }, `[${this.name}] Invalid repair flag data`);
				await db.delete(settings).where(eq(settings.key, flag.key));
				continue;
			}

			const result = await this.repairSingleSeries(seriesId, data);
			results.push(result);

			// Remove the repair flag regardless of success
			await db.delete(settings).where(eq(settings.key, flag.key));

			// Small delay between TMDB API calls
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		// Log summary
		const successful = results.filter((r) => r.success);
		const failed = results.filter((r) => !r.success);

		logger.info(
			{
				total: results.length,
				successful: successful.length,
				failed: failed.length,
				episodesCreated: successful.reduce((sum, r) => sum + r.episodesCreated, 0),
				episodeFilesLinked: successful.reduce((sum, r) => sum + r.episodeFilesLinked, 0)
			},
			`[${this.name}] Repair complete`
		);

		if (failed.length > 0) {
			logger.warn(
				{
					failures: failed.map((f) => ({ title: f.title, error: f.error }))
				},
				`[${this.name}] Some series failed to repair`
			);
		}
	}

	/**
	 * Repair a single series by fetching TMDB metadata and linking episode files
	 */
	private async repairSingleSeries(
		seriesId: string,
		data: RepairSeriesData
	): Promise<RepairResult> {
		const result: RepairResult = {
			seriesId,
			title: data.title,
			success: false,
			seasonsCreated: 0,
			episodesCreated: 0,
			episodeFilesLinked: 0
		};

		try {
			// Check if series still exists
			const [existingSeries] = await db.select().from(series).where(eq(series.id, seriesId));

			if (!existingSeries) {
				result.error = 'Series no longer exists';
				return result;
			}

			// Check if series already has episodes (maybe repaired manually)
			const existingEpisodes = await db
				.select()
				.from(episodes)
				.where(eq(episodes.seriesId, seriesId));

			if (existingEpisodes.length > 0) {
				logger.debug(
					{
						title: data.title,
						episodeCount: existingEpisodes.length
					},
					`[${this.name}] Series already has episodes, skipping`
				);
				result.success = true;
				return result;
			}

			// Fetch show details from TMDB
			const details = await tmdb.getTVShow(data.tmdbId);

			if (!details.seasons || details.seasons.length === 0) {
				result.error = 'No seasons found in TMDB';
				return result;
			}

			// Create seasons and episodes
			for (const seasonInfo of details.seasons) {
				try {
					const fullSeason = await tmdb.getSeason(data.tmdbId, seasonInfo.season_number);
					const isSpecials = seasonInfo.season_number === 0;

					// Create season record
					const [insertedSeason] = await db
						.insert(seasons)
						.values({
							seriesId,
							seasonNumber: seasonInfo.season_number,
							name: seasonInfo.name,
							overview: seasonInfo.overview,
							posterPath: seasonInfo.poster_path,
							airDate: seasonInfo.air_date,
							episodeCount: seasonInfo.episode_count ?? 0,
							episodeFileCount: 0,
							monitored: !isSpecials
						})
						.onConflictDoNothing()
						.returning();
					const newSeason =
						insertedSeason ??
						(await db
							.select()
							.from(seasons)
							.where(
								and(
									eq(seasons.seriesId, seriesId),
									eq(seasons.seasonNumber, seasonInfo.season_number)
								)
							)
							.then((rows) => rows[0]));

					if (insertedSeason) result.seasonsCreated++;

					// Create episode records
					if (fullSeason.episodes) {
						for (const ep of fullSeason.episodes) {
							await db
								.insert(episodes)
								.values({
									seriesId,
									seasonId: newSeason.id,
									seasonNumber: ep.season_number,
									episodeNumber: ep.episode_number,
									tmdbId: ep.id,
									title: ep.name,
									overview: ep.overview,
									airDate: ep.air_date,
									runtime: ep.runtime,
									monitored: !isSpecials,
									hasFile: false
								})
								.onConflictDoNothing();
							result.episodesCreated++;
						}
					}

					// Small delay between season fetches
					await new Promise((resolve) => setTimeout(resolve, 100));
				} catch (err) {
					logger.warn(
						{
							title: data.title,
							season: seasonInfo.season_number,
							err
						},
						`[${this.name}] Failed to fetch season`
					);
				}
			}

			// Now link episode_files to the newly created episodes
			result.episodeFilesLinked = await this.linkEpisodeFiles(seriesId);

			// Update series episode counts
			const allEpisodes = await db.select().from(episodes).where(eq(episodes.seriesId, seriesId));

			const today = todayDateString();
			const isAired = (ep: typeof episodes.$inferSelect) =>
				Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);

			// Filter to regular (non-specials) AND aired episodes
			const regularEpisodes = allEpisodes.filter((e) => e.seasonNumber !== 0 && isAired(e));
			const episodesWithFiles = regularEpisodes.filter((e) => e.hasFile);

			await db
				.update(series)
				.set({
					episodeCount: regularEpisodes.length,
					episodeFileCount: episodesWithFiles.length
				})
				.where(eq(series.id, seriesId));

			// Update season episode counts (only aired episodes)
			const allSeasons = await db.select().from(seasons).where(eq(seasons.seriesId, seriesId));

			for (const season of allSeasons) {
				const seasonAiredEpisodes = allEpisodes.filter(
					(e) => e.seasonId === season.id && isAired(e)
				);
				const seasonEpisodesWithFiles = seasonAiredEpisodes.filter((e) => e.hasFile);
				await db
					.update(seasons)
					.set({
						episodeCount: seasonAiredEpisodes.length,
						episodeFileCount: seasonEpisodesWithFiles.length
					})
					.where(eq(seasons.id, season.id));
			}

			result.success = true;
			logger.info(
				{
					title: data.title,
					seasonsCreated: result.seasonsCreated,
					episodesCreated: result.episodesCreated,
					episodeFilesLinked: result.episodeFilesLinked
				},
				`[${this.name}] Repaired series`
			);
		} catch (err) {
			result.error = err instanceof Error ? err.message : String(err);
			logger.error(
				{
					title: data.title,
					err
				},
				`[${this.name}] Failed to repair series`
			);
		}

		return result;
	}

	/**
	 * Link episode_files to episodes by matching season/episode numbers
	 */
	private async linkEpisodeFiles(seriesId: string): Promise<number> {
		// Get all episode_files for this series
		const files = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));

		// Get all episodes for this series
		const allEpisodes = await db.select().from(episodes).where(eq(episodes.seriesId, seriesId));

		let linkedCount = 0;

		for (const file of files) {
			// Skip files that already have valid episode links
			if (file.episodeIds && file.episodeIds.length > 0) {
				continue;
			}

			// Find matching episode(s) by season and episode number
			// The file should have seasonNumber set
			const seasonNum = file.seasonNumber;

			// Try to determine episode numbers from the relativePath
			const episodeNums = this.parseEpisodeNumbers(file.relativePath);

			if (episodeNums.length === 0) {
				continue;
			}

			// Find matching episodes
			const matchingEpisodes = allEpisodes.filter(
				(ep) => ep.seasonNumber === seasonNum && episodeNums.includes(ep.episodeNumber)
			);

			if (matchingEpisodes.length > 0) {
				const episodeIds = matchingEpisodes.map((ep) => ep.id);

				// Update the episode_file with the episode IDs
				await db.update(episodeFiles).set({ episodeIds }).where(eq(episodeFiles.id, file.id));

				// Mark episodes as having a file
				for (const ep of matchingEpisodes) {
					await db.update(episodes).set({ hasFile: true }).where(eq(episodes.id, ep.id));
				}

				linkedCount++;
			}
		}

		return linkedCount;
	}

	/**
	 * Parse episode numbers from a file path
	 * Handles common patterns like S01E01, S01E01E02, etc.
	 */
	private parseEpisodeNumbers(relativePath: string): number[] {
		const episodeNums: number[] = [];

		// Match patterns like E01, E02, etc.
		const matches = relativePath.match(/[Ee](\d{1,3})/g);

		if (matches) {
			for (const match of matches) {
				const num = parseInt(match.slice(1), 10);
				if (!isNaN(num) && num > 0) {
					episodeNums.push(num);
				}
			}
		}

		return episodeNums;
	}
}

// Singleton instance
let dataRepairService: DataRepairService | null = null;

export function getDataRepairService(): DataRepairService {
	if (!dataRepairService) {
		dataRepairService = new DataRepairService();
	}
	return dataRepairService;
}

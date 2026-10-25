/**
 * Manual backfill: regenerate sidecar files (.nfo + poster/fanart) across
 * the whole library. Unlike the on-import write path in ImportService.ts,
 * this always overwrites - "regenerate" is an explicit, one-time request
 * for fresh files, not the passive skip-if-exists behavior normal imports
 * use. It still respects the includeArtwork/tvSeriesLevel/tvSeasonLevel/
 * tvEpisodeLevel settings for *what* to generate, and runs independent of
 * the master `enabled` toggle - a user may want to run this once without
 * turning on write-on-every-future-import.
 */

import { eq, and, inArray, gt } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	movies,
	movieFiles,
	series,
	seasons,
	episodes,
	episodeFiles,
	rootFolders
} from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getSidecarSettings } from './sidecarSettings.js';
import {
	buildMovieNfo,
	buildSeriesNfo,
	buildSeasonNfo,
	buildEpisodeNfo,
	nfoPathFor
} from './NfoGenerator.js';
import {
	downloadSidecarImage,
	tmdbImageUrl,
	movieArtworkPaths,
	seriesArtworkPaths,
	seasonArtworkPath,
	folderOf
} from './SidecarImageService.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const logger = createChildLogger({ logDomain: 'imports' as const });

export interface RegenerateSidecarsResult {
	total: number;
	updated: number;
	failed: number;
	errors: Array<{ id: string; title: string; error: string }>;
}

// Avoids bursting hundreds of requests at once for a large
// library. No TaskExecutionContext needed here (this endpoint isn't
// thread through one - see the maintenance-task registration for why).
const ARTWORK_DELAY_MS = 100;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function regenerateSidecars(): Promise<RegenerateSidecarsResult> {
	const settings = getSidecarSettings();
	const result: RegenerateSidecarsResult = { total: 0, updated: 0, failed: 0, errors: [] };

	// --- Movies ---
	const movieRows = await db
		.select({ movie: movies, file: movieFiles, rootFolderPath: rootFolders.path })
		.from(movies)
		.innerJoin(movieFiles, eq(movieFiles.movieId, movies.id))
		.leftJoin(rootFolders, eq(rootFolders.id, movies.rootFolderId))
		.where(eq(movies.hasFile, true));

	for (const { movie, file, rootFolderPath } of movieRows) {
		result.total++;
		if (!rootFolderPath) {
			result.failed++;
			result.errors.push({ id: movie.id, title: movie.title, error: 'No root folder configured' });
			continue;
		}
		try {
			const destPath = join(rootFolderPath, movie.path, file.relativePath);
			await writeFile(
				nfoPathFor(destPath),
				buildMovieNfo(movie, file, settings.includeArtwork),
				'utf-8'
			);

			if (settings.includeArtwork) {
				const { poster, fanart } = movieArtworkPaths(folderOf(destPath));
				await downloadSidecarImage(tmdbImageUrl(movie.posterPath), poster, true);
				await delay(ARTWORK_DELAY_MS);
				await downloadSidecarImage(tmdbImageUrl(movie.backdropPath), fanart, true);
				await delay(ARTWORK_DELAY_MS);
			}
			result.updated++;
		} catch (err) {
			result.failed++;
			const message = err instanceof Error ? err.message : String(err);
			result.errors.push({ id: movie.id, title: movie.title, error: message });
			logger.warn(
				{ movieId: movie.id, err: message },
				'[Sidecar] Failed to regenerate movie sidecars'
			);
		}
	}

	// --- Series (show-level tvshow.nfo + poster/fanart) ---
	if (settings.tvSeriesLevel) {
		const seriesRows = await db
			.select({ series: series, rootFolderPath: rootFolders.path })
			.from(series)
			.leftJoin(rootFolders, eq(rootFolders.id, series.rootFolderId));

		for (const { series: seriesRow, rootFolderPath } of seriesRows) {
			result.total++;
			if (!rootFolderPath) {
				result.failed++;
				result.errors.push({
					id: seriesRow.id,
					title: seriesRow.title,
					error: 'No root folder configured'
				});
				continue;
			}
			try {
				const seriesFolder = join(rootFolderPath, seriesRow.path);
				await writeFile(
					join(seriesFolder, 'tvshow.nfo'),
					buildSeriesNfo(seriesRow, settings.includeArtwork),
					'utf-8'
				);

				if (settings.includeArtwork) {
					const { poster, fanart } = seriesArtworkPaths(seriesFolder);
					await downloadSidecarImage(tmdbImageUrl(seriesRow.posterPath), poster, true);
					await delay(ARTWORK_DELAY_MS);
					await downloadSidecarImage(tmdbImageUrl(seriesRow.backdropPath), fanart, true);
					await delay(ARTWORK_DELAY_MS);
				}
				result.updated++;
			} catch (err) {
				result.failed++;
				const message = err instanceof Error ? err.message : String(err);
				result.errors.push({ id: seriesRow.id, title: seriesRow.title, error: message });
				logger.warn(
					{ seriesId: seriesRow.id, err: message },
					'[Sidecar] Failed to regenerate series-level sidecars'
				);
			}
		}
	}

	// --- Seasons (season.nfo, written inside the season's own subfolder + season poster) ---
	if (settings.tvSeasonLevel) {
		const seasonRows = await db
			.select({
				season: seasons,
				seriesTitle: series.title,
				seriesPath: series.path,
				rootFolderPath: rootFolders.path
			})
			.from(seasons)
			.innerJoin(series, eq(series.id, seasons.seriesId))
			.leftJoin(rootFolders, eq(rootFolders.id, series.rootFolderId))
			.where(gt(seasons.episodeFileCount, 0));

		for (const { season, seriesTitle, seriesPath, rootFolderPath } of seasonRows) {
			result.total++;
			if (!rootFolderPath) {
				result.failed++;
				result.errors.push({
					id: `${season.seriesId}-s${season.seasonNumber}`,
					title: `${seriesTitle} S${season.seasonNumber}`,
					error: 'No root folder configured'
				});
				continue;
			}
			try {
				const seriesFolder = join(rootFolderPath, seriesPath);

				// season.nfo lives inside the season's own subfolder (per Jellyfin's
				// SeasonNfoProvider), which isn't stored anywhere directly - derive
				// it from any episode file already known to belong to this season.
				const [episodeFile] = await db
					.select({ relativePath: episodeFiles.relativePath })
					.from(episodeFiles)
					.where(
						and(
							eq(episodeFiles.seriesId, season.seriesId),
							eq(episodeFiles.seasonNumber, season.seasonNumber)
						)
					)
					.limit(1);

				if (episodeFile) {
					const seasonFolder = folderOf(join(seriesFolder, episodeFile.relativePath));
					await writeFile(join(seasonFolder, 'season.nfo'), buildSeasonNfo(season), 'utf-8');
				}

				if (settings.includeArtwork && season.posterPath) {
					await downloadSidecarImage(
						tmdbImageUrl(season.posterPath),
						seasonArtworkPath(seriesFolder, season.seasonNumber),
						true
					);
					await delay(ARTWORK_DELAY_MS);
				}
				result.updated++;
			} catch (err) {
				result.failed++;
				const message = err instanceof Error ? err.message : String(err);
				result.errors.push({
					id: `${season.seriesId}-s${season.seasonNumber}`,
					title: `${seriesTitle} S${season.seasonNumber}`,
					error: message
				});
			}
		}
	}

	// --- Episodes (.nfo only - no source data for episode-level images) ---
	if (settings.tvEpisodeLevel) {
		const episodeFileRows = await db
			.select({ file: episodeFiles, series: series, rootFolderPath: rootFolders.path })
			.from(episodeFiles)
			.innerJoin(series, eq(series.id, episodeFiles.seriesId))
			.leftJoin(rootFolders, eq(rootFolders.id, series.rootFolderId));

		for (const { file, series: seriesRow, rootFolderPath } of episodeFileRows) {
			result.total++;
			if (!rootFolderPath || !file.episodeIds?.length) {
				continue;
			}
			try {
				const episodesInFile = await db
					.select()
					.from(episodes)
					.where(inArray(episodes.id, file.episodeIds));
				if (episodesInFile.length === 0) continue;

				const destPath = join(rootFolderPath, seriesRow.path, file.relativePath);
				await writeFile(
					nfoPathFor(destPath),
					buildEpisodeNfo(seriesRow, episodesInFile, file),
					'utf-8'
				);
				result.updated++;
			} catch (err) {
				result.failed++;
				const message = err instanceof Error ? err.message : String(err);
				result.errors.push({ id: file.id, title: seriesRow.title, error: message });
				logger.warn(
					{ fileId: file.id, seriesId: seriesRow.id, err: message },
					'[Sidecar] Failed to regenerate episode sidecar'
				);
			}
		}
	}

	logger.info(
		{ total: result.total, updated: result.updated, failed: result.failed },
		'[Sidecar] Regenerate sidecars completed'
	);

	return result;
}

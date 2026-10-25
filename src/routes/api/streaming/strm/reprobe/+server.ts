/**
 * Reprobe .strm Media Info Endpoint
 *
 * Re-extracts media info for existing .strm files by probing the URL inside the .strm.
 * Falls back to synthetic STRM defaults on failure.
 *
 * POST /api/streaming/strm/reprobe
 */

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { movieFiles, movies, episodeFiles, series, rootFolders } from '#lib/server/db/schema.js';
import { mediaInfoService } from '#lib/server/library/media-info.js';
import { createChildLogger } from '#lib/logging/index.js';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'StrmReprobeAPI' });

type ReprobeResult = {
	success: boolean;
	total: number;
	distinctTotal: number;
	updated: number;
	probeFallbackUsed: number;
	failed: number;
	skipped: number;
	skippedStreamer: number;
	collapsedDuplicates: number;
	errors: Array<{ id: string; path: string; error: string }>;
};

function resolveMediaPath(
	rootPath: string,
	parentPath: string | null,
	relativePath: string
): string {
	const cleanedParent = (parentPath ?? '').replace(/^[/\\]+/, '');
	if (
		cleanedParent &&
		(relativePath === cleanedParent || relativePath.startsWith(`${cleanedParent}/`))
	) {
		return join(rootPath, relativePath);
	}
	return join(rootPath, cleanedParent, relativePath);
}

export const POST: RequestHandler = async (event) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result: ReprobeResult = {
			success: true,
			total: 0,
			distinctTotal: 0,
			updated: 0,
			probeFallbackUsed: 0,
			failed: 0,
			skipped: 0,
			skippedStreamer: 0,
			collapsedDuplicates: 0,
			errors: []
		};
		const distinctPaths = new Set<string>();
		const movieGroups = new Map<string, string[]>();
		const episodeGroups = new Map<string, string[]>();

		const movieStrmLike = sql`lower(${movieFiles.relativePath}) like '%.strm'`;
		const episodeStrmLike = sql`lower(${episodeFiles.relativePath}) like '%.strm'`;
		const nonStreamerMovieProfile = or(
			isNull(movies.scoringProfileId),
			ne(movies.scoringProfileId, 'streamer')
		);
		const nonStreamerSeriesProfile = or(
			isNull(series.scoringProfileId),
			ne(series.scoringProfileId, 'streamer')
		);

		// Count streamer-profile STRM rows for reporting, but do not load/process them.
		const [movieStreamerCountRows, episodeStreamerCountRows] = await Promise.all([
			db
				.select({ count: sql<number>`count(*)` })
				.from(movieFiles)
				.leftJoin(movies, eq(movieFiles.movieId, movies.id))
				.where(and(movieStrmLike, eq(movies.scoringProfileId, 'streamer'))),
			db
				.select({ count: sql<number>`count(*)` })
				.from(episodeFiles)
				.leftJoin(series, eq(episodeFiles.seriesId, series.id))
				.where(and(episodeStrmLike, eq(series.scoringProfileId, 'streamer')))
		]);
		result.skippedStreamer =
			Number(movieStreamerCountRows[0]?.count ?? 0) +
			Number(episodeStreamerCountRows[0]?.count ?? 0);

		const movieStrmFiles = await db
			.select({
				id: movieFiles.id,
				relativePath: movieFiles.relativePath,
				moviePath: movies.path,
				rootPath: rootFolders.path
			})
			.from(movieFiles)
			.leftJoin(movies, eq(movieFiles.movieId, movies.id))
			.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
			.where(and(movieStrmLike, nonStreamerMovieProfile));

		const episodeStrmFiles = await db
			.select({
				id: episodeFiles.id,
				relativePath: episodeFiles.relativePath,
				seriesPath: series.path,
				rootPath: rootFolders.path
			})
			.from(episodeFiles)
			.leftJoin(series, eq(episodeFiles.seriesId, series.id))
			.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
			.where(and(episodeStrmLike, nonStreamerSeriesProfile));

		for (const file of movieStrmFiles) {
			if (!file.rootPath || !file.moviePath) {
				result.skipped += 1;
				continue;
			}
			const fullPath = resolveMediaPath(file.rootPath, file.moviePath, file.relativePath);
			if (!existsSync(fullPath)) {
				continue;
			}
			if (!movieGroups.has(fullPath)) {
				movieGroups.set(fullPath, []);
			}
			movieGroups.get(fullPath)!.push(file.id);
		}

		for (const file of episodeStrmFiles) {
			if (!file.rootPath || !file.seriesPath) {
				result.skipped += 1;
				continue;
			}
			const fullPath = resolveMediaPath(file.rootPath, file.seriesPath, file.relativePath);
			if (!existsSync(fullPath)) {
				continue;
			}
			if (!episodeGroups.has(fullPath)) {
				episodeGroups.set(fullPath, []);
			}
			episodeGroups.get(fullPath)!.push(file.id);
		}

		for (const [fullPath, ids] of movieGroups) {
			distinctPaths.add(fullPath);
			try {
				let fallbackUsed = false;
				const mediaInfo = await mediaInfoService.extractMediaInfo(fullPath, {
					failOnInvalidStrmUrl: true,
					onStrmProbeFallback: () => {
						fallbackUsed = true;
					}
				});
				if (!mediaInfo) {
					throw new Error('Probe failed and fallback media info could not be generated');
				}
				await db.update(movieFiles).set({ mediaInfo }).where(inArray(movieFiles.id, ids));
				result.updated += 1;
				if (fallbackUsed) result.probeFallbackUsed += 1;
			} catch (error) {
				result.failed += 1;
				const message = error instanceof Error ? error.message : String(error);
				result.errors.push({ id: ids[0], path: fullPath, error: message });
			}
		}

		for (const [fullPath, ids] of episodeGroups) {
			distinctPaths.add(fullPath);
			try {
				let fallbackUsed = false;
				const mediaInfo = await mediaInfoService.extractMediaInfo(fullPath, {
					failOnInvalidStrmUrl: true,
					onStrmProbeFallback: () => {
						fallbackUsed = true;
					}
				});
				if (!mediaInfo) {
					throw new Error('Probe failed and fallback media info could not be generated');
				}
				await db.update(episodeFiles).set({ mediaInfo }).where(inArray(episodeFiles.id, ids));
				result.updated += 1;
				if (fallbackUsed) result.probeFallbackUsed += 1;
			} catch (error) {
				result.failed += 1;
				const message = error instanceof Error ? error.message : String(error);
				result.errors.push({ id: ids[0], path: fullPath, error: message });
			}
		}

		result.total = distinctPaths.size;
		const scannedRowCount =
			Array.from(movieGroups.values()).reduce((sum, ids) => sum + ids.length, 0) +
			Array.from(episodeGroups.values()).reduce((sum, ids) => sum + ids.length, 0);
		result.collapsedDuplicates = scannedRowCount - result.total;

		logger.info(
			{
				total: result.total,
				distinctTotal: distinctPaths.size,
				updated: result.updated,
				probeFallbackUsed: result.probeFallbackUsed,
				failed: result.failed,
				skipped: result.skipped,
				skippedStreamer: result.skippedStreamer,
				collapsedDuplicates: result.collapsedDuplicates
			},
			'[StrmReprobeAPI] Completed'
		);

		result.distinctTotal = distinctPaths.size;
		return Response.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, '[StrmReprobeAPI] Failed');
		return Response.json(
			{
				success: false,
				total: 0,
				distinctTotal: 0,
				updated: 0,
				probeFallbackUsed: 0,
				failed: 0,
				skipped: 0,
				skippedStreamer: 0,
				collapsedDuplicates: 0,
				errors: [{ id: 'global', path: 'global', error: message }]
			},
			{ status: 500 }
		);
	}
};

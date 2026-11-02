import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { seasons, episodes, episodeFiles, series, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeasonByIdApi', logDomain: 'scans' });

/**
 * PATCH /api/library/seasons/[id]
 * Update season settings (primarily monitoring)
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { monitored } = body;

		// Validate season exists
		const [season] = await db.select().from(seasons).where(eq(seasons.id, params.id)).limit(1);

		if (!season) {
			return Response.json({ success: false, error: 'Season not found' }, { status: 404 });
		}

		const updateData: Record<string, unknown> = {};

		if (typeof monitored === 'boolean') {
			updateData.monitored = monitored;
		}

		if (Object.keys(updateData).length === 0) {
			return Response.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
		}

		// Update season
		await db.update(seasons).set(updateData).where(eq(seasons.id, params.id));

		// If toggling monitoring, optionally update all episodes in this season
		if (typeof monitored === 'boolean' && body.updateEpisodes === true) {
			await db.update(episodes).set({ monitored }).where(eq(episodes.seasonId, params.id));
		}

		libraryMediaEvents.emitSeriesUpdated(season.seriesId);

		return Response.json({ success: true });
	} catch (error) {
		logger.error('[API] Error updating season', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to update season'
			},
			{ status: 500 }
		);
	}
};

// Alias PUT to PATCH for convenience
export const PUT: RequestHandler = PATCH;

/**
 * DELETE /api/library/seasons/[id]
 * Delete files for a season (keeps metadata, marks episodes as missing)
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
	try {
		const deleteFiles = url.searchParams.get('deleteFiles') === 'true';

		// Get season with series and root folder info
		const [season] = await db
			.select({
				id: seasons.id,
				seasonNumber: seasons.seasonNumber,
				seriesId: seasons.seriesId,
				seriesPath: series.path,
				rootFolderPath: rootFolders.path,
				rootFolderReadOnly: rootFolders.readOnly
			})
			.from(seasons)
			.innerJoin(series, eq(seasons.seriesId, series.id))
			.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
			.where(eq(seasons.id, params.id));

		if (!season) {
			return Response.json({ success: false, error: 'Season not found' }, { status: 404 });
		}

		// Get all episode files for this season
		const allFiles = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, season.seriesId));

		const seasonFiles = allFiles.filter((f) => f.seasonNumber === season.seasonNumber);

		if (seasonFiles.length === 0) {
			return Response.json(
				{ success: false, error: 'Season has no files to delete' },
				{ status: 400 }
			);
		}

		// Block file deletion from read-only folders
		if (deleteFiles && season.rootFolderReadOnly) {
			return Response.json(
				{ success: false, error: 'Cannot delete files from read-only folder' },
				{ status: 400 }
			);
		}

		// Delete files from disk if requested
		if (deleteFiles && season.rootFolderPath && season.seriesPath) {
			for (const file of seasonFiles) {
				const fullPath = join(season.rootFolderPath, season.seriesPath, file.relativePath);
				try {
					await unlink(fullPath);
					logger.debug({ fullPath }, '[API] Deleted file');
				} catch {
					logger.warn({ fullPath }, '[API] Could not delete file');
				}
			}

			// Try to remove the season folder
			const seasonFolder = join(
				season.rootFolderPath,
				season.seriesPath,
				`Season ${String(season.seasonNumber).padStart(2, '0')}`
			);
			try {
				await rmdir(seasonFolder);
				logger.debug({ seasonFolder }, '[API] Removed season folder');
			} catch {
				// Folder not empty or doesn't exist - that's fine
			}
		}

		// Delete episode file records from database
		for (const file of seasonFiles) {
			await db.delete(episodeFiles).where(eq(episodeFiles.id, file.id));
		}

		// Update all episodes in this season to hasFile=false
		await db
			.update(episodes)
			.set({ hasFile: false, lastSearchTime: null })
			.where(eq(episodes.seasonId, params.id));

		// Update season episodeFileCount to 0
		await db.update(seasons).set({ episodeFileCount: 0 }).where(eq(seasons.id, params.id));

		// Recalculate series episodeFileCount
		const remainingFilesCount = await db
			.select({ id: episodeFiles.id })
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, season.seriesId))
			.then((files) => files.length);

		await db
			.update(series)
			.set({ episodeFileCount: remainingFilesCount })
			.where(eq(series.id, season.seriesId));

		libraryMediaEvents.emitSeriesUpdated(season.seriesId);

		// Note: Season and episode metadata is kept - episodes will show as "missing"
		return Response.json({ success: true });
	} catch (error) {
		logger.error('[API] Error deleting season files', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete season files'
			},
			{ status: 500 }
		);
	}
};

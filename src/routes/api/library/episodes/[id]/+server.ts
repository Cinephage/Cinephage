import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { episodes, episodeFiles, series, seasons, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { unlink, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { searchOnAdd } from '#lib/server/library/searchOnAdd.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';
import { episodeUpdateSchema } from '#lib/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';

const logger = createChildLogger({ module: 'LibraryEpisodeByIdApi', logDomain: 'scans' });

/**
 * PATCH /api/library/episodes/[id]
 * Update episode settings (primarily monitoring)
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const { monitored, wantsSubtitlesOverride, subtitleRequirementsOverride } = await parseBody(
		request,
		episodeUpdateSchema
	);

	try {
		// Validate episode exists
		const [episode] = await db.select().from(episodes).where(eq(episodes.id, params.id)).limit(1);

		if (!episode) {
			return Response.json({ success: false, error: 'Episode not found' }, { status: 404 });
		}

		// Detect if monitoring is being enabled (was false, now true)
		const wasUnmonitored = !episode.monitored;
		const nowMonitored = typeof monitored === 'boolean' && monitored === true;

		const updateData: Record<string, unknown> = {};

		if (typeof monitored === 'boolean') {
			updateData.monitored = monitored;
		}
		if (wantsSubtitlesOverride !== undefined) {
			// Tri-state: true forces subtitles on, false opts out, null inherits
			// from the series.
			updateData.wantsSubtitlesOverride = wantsSubtitlesOverride;
		}
		if (subtitleRequirementsOverride !== undefined) {
			// Validated requirement list or null to clear (inherit via series).
			updateData.subtitleRequirementsOverride = subtitleRequirementsOverride;
		}

		// Update episode
		await db.update(episodes).set(updateData).where(eq(episodes.id, params.id));

		// If monitoring was just enabled and episode has no file, check if we should trigger a search
		if (wasUnmonitored && nowMonitored && !episode.hasFile) {
			const settings = await monitoringScheduler.getSettings();

			if (settings.searchOnMonitorEnabled) {
				const [seriesRecord] = await db
					.select({ monitored: series.monitored })
					.from(series)
					.where(eq(series.id, episode.seriesId))
					.limit(1);

				if (seriesRecord && !seriesRecord.monitored) {
					logger.info(
						{
							episodeId: params.id,
							seriesId: episode.seriesId
						},
						'[API] Skipping search for episode in unmonitored series'
					);
					return Response.json({ success: true });
				}

				// Fire and forget - don't block the response
				searchOnAdd.searchForEpisode({ episodeId: params.id }).catch((e: unknown) => {
					logger.error(
						{
							episodeId: params.id,
							error: e instanceof Error ? e.message : 'Unknown error'
						},
						'[API] Background search on episode monitor enable failed'
					);
				});

				logger.info(
					{
						episodeId: params.id
					},
					'[API] Triggered search on monitor enable for episode'
				);
			}
		}

		libraryMediaEvents.emitSeriesUpdated(episode.seriesId);

		return Response.json({ success: true });
	} catch (error) {
		logger.error('[API] Error updating episode', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to update episode'
			},
			{ status: 500 }
		);
	}
};

// Alias PUT to PATCH for convenience
export const PUT: RequestHandler = PATCH;

/**
 * DELETE /api/library/episodes/[id]
 * Delete files for an episode (keeps metadata, marks as missing)
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
	try {
		const deleteFiles = url.searchParams.get('deleteFiles') === 'true';

		// Get episode with series and root folder info
		const [episode] = await db
			.select({
				id: episodes.id,
				seriesId: episodes.seriesId,
				seasonId: episodes.seasonId,
				hasFile: episodes.hasFile,
				seriesPath: series.path,
				rootFolderPath: rootFolders.path,
				rootFolderReadOnly: rootFolders.readOnly
			})
			.from(episodes)
			.innerJoin(series, eq(episodes.seriesId, series.id))
			.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
			.where(eq(episodes.id, params.id));

		if (!episode) {
			return Response.json({ success: false, error: 'Episode not found' }, { status: 404 });
		}

		if (!episode.hasFile) {
			return Response.json(
				{ success: false, error: 'Episode has no files to delete' },
				{ status: 400 }
			);
		}

		// Block file deletion from read-only folders
		if (deleteFiles && episode.rootFolderReadOnly) {
			return Response.json(
				{ success: false, error: 'Cannot delete files from read-only folder' },
				{ status: 400 }
			);
		}

		// Find files that include this episode
		const allFiles = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, episode.seriesId));

		const episodeFilesToDelete = allFiles.filter(
			(f) => f.episodeIds && f.episodeIds.includes(params.id)
		);

		// Delete files from disk if requested
		if (deleteFiles && episode.rootFolderPath && episode.seriesPath) {
			for (const file of episodeFilesToDelete) {
				const fullPath = join(episode.rootFolderPath, episode.seriesPath, file.relativePath);
				try {
					await unlink(fullPath);
					logger.debug({ fullPath }, '[API] Deleted episode file');

					// Try to remove empty parent directories
					let currentDir = dirname(fullPath);
					const seriesFolder = join(episode.rootFolderPath, episode.seriesPath);
					while (currentDir !== seriesFolder && currentDir.startsWith(seriesFolder)) {
						try {
							await rmdir(currentDir);
							currentDir = dirname(currentDir);
						} catch {
							break;
						}
					}
				} catch {
					logger.warn({ fullPath }, '[API] Could not delete episode file');
				}
			}
		}

		// Delete file records from database
		for (const file of episodeFilesToDelete) {
			await db.delete(episodeFiles).where(eq(episodeFiles.id, file.id));
		}

		// Query remaining files ONCE after all deletions
		const remainingFiles = await db
			.select({ episodeIds: episodeFiles.episodeIds })
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, episode.seriesId));

		// Collect all affected episode IDs
		const affectedEpisodeIds = new Set<string>();
		for (const file of episodeFilesToDelete) {
			for (const epId of file.episodeIds || []) {
				affectedEpisodeIds.add(epId);
			}
		}

		// Update hasFile for affected episodes using in-memory check
		for (const epId of affectedEpisodeIds) {
			const stillHasFile = remainingFiles.some((f) => f.episodeIds && f.episodeIds.includes(epId));
			if (!stillHasFile) {
				await db
					.update(episodes)
					.set({ hasFile: false, lastSearchTime: null })
					.where(eq(episodes.id, epId));
			}
		}

		// Recalculate season episodeFileCount (only if episode has a season)
		if (episode.seasonId) {
			const seasonEpisodesWithFiles = await db
				.select({ hasFile: episodes.hasFile })
				.from(episodes)
				.where(eq(episodes.seasonId, episode.seasonId))
				.then((eps) => eps.filter((e) => e.hasFile).length);

			await db
				.update(seasons)
				.set({ episodeFileCount: seasonEpisodesWithFiles })
				.where(eq(seasons.id, episode.seasonId));
		}

		// Recalculate series episodeFileCount
		const seriesEpisodesWithFiles = await db
			.select({ hasFile: episodes.hasFile })
			.from(episodes)
			.where(eq(episodes.seriesId, episode.seriesId))
			.then((eps) => eps.filter((e) => e.hasFile).length);

		await db
			.update(series)
			.set({ episodeFileCount: seriesEpisodesWithFiles })
			.where(eq(series.id, episode.seriesId));

		libraryMediaEvents.emitSeriesUpdated(episode.seriesId);

		// Note: Episode metadata is kept - it will show as "missing"
		return Response.json({ success: true });
	} catch (error) {
		logger.error('[API] Error deleting episode files', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete episode files'
			},
			{ status: 500 }
		);
	}
};

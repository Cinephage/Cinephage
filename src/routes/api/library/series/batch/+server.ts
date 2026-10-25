import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import {
	downloadHistory,
	series,
	seasons,
	episodes,
	episodeFiles,
	rootFolders
} from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { deleteDirectoryWithinRoot } from '#lib/server/filesystem/delete-helpers.js';
import { deleteAllAlternateTitles } from '#lib/server/services/index.js';
import { monitoringSearchService } from '#lib/server/monitoring/search/MonitoringSearchService.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeriesBatchApi', logDomain: 'scans' });

/**
 * PATCH /api/library/series/batch
 * Batch update series settings (monitored, scoringProfileId)
 *
 * Body:
 * - seriesIds: string[] - Array of series IDs to update
 * - updates: { monitored?: boolean, scoringProfileId?: string | null }
 */
export const PATCH: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { seriesIds, updates } = body;

		if (!seriesIds || !Array.isArray(seriesIds) || seriesIds.length === 0) {
			return Response.json(
				{ success: false, error: 'seriesIds array is required and must not be empty' },
				{ status: 400 }
			);
		}

		if (!updates || typeof updates !== 'object') {
			return Response.json(
				{ success: false, error: 'updates object is required' },
				{ status: 400 }
			);
		}

		const updateData: Record<string, unknown> = {};

		if (typeof updates.monitored === 'boolean') {
			updateData.monitored = updates.monitored;
		}

		if (updates.scoringProfileId !== undefined) {
			updateData.scoringProfileId = updates.scoringProfileId;
		}

		if (Object.keys(updateData).length === 0) {
			return Response.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
		}

		const result = await db.update(series).set(updateData).where(inArray(series.id, seriesIds));

		if (updates.scoringProfileId !== undefined) {
			// Fire and forget upgrade search when profile changes
			monitoringSearchService
				.searchForUpgrades({
					seriesIds,
					cutoffUnmetOnly: false,
					ignoreCooldown: true
				})
				.catch((err) => {
					logger.error(
						{
							error: err instanceof Error ? err.message : 'Unknown error'
						},
						'[API] Background upgrade search on batch profile change failed'
					);
				});

			logger.info(
				{
					seriesIds,
					newProfile: updates.scoringProfileId
				},
				'[API] Triggered upgrade search on batch profile change for series'
			);
		}

		if (typeof updates.monitored === 'boolean') {
			await db
				.update(seasons)
				.set({ monitored: updates.monitored })
				.where(inArray(seasons.seriesId, seriesIds));
			await db
				.update(episodes)
				.set({ monitored: updates.monitored })
				.where(inArray(episodes.seriesId, seriesIds));
		}

		libraryMediaEvents.emitLibraryDataChanged({
			source: 'series',
			reason: 'batch-updated'
		});

		return Response.json({
			success: true,
			updatedCount: result.changes
		});
	} catch (error) {
		logger.error('[API] Error batch updating series', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to batch update series'
			},
			{ status: 500 }
		);
	}
};

// Alias PUT to PATCH for convenience
export const PUT: RequestHandler = PATCH;

/**
 * DELETE /api/library/series/batch
 * Batch delete series files
 *
 * Body:
 * - seriesIds: string[] - Array of series IDs to delete files for
 * - deleteFiles?: boolean - Whether to delete files from disk (default: false)
 * - removeFromLibrary?: boolean - Whether to remove series from library entirely (default: false)
 */
export const DELETE: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { seriesIds, deleteFiles = false, removeFromLibrary = false } = body;

		if (!seriesIds || !Array.isArray(seriesIds) || seriesIds.length === 0) {
			return Response.json(
				{ success: false, error: 'seriesIds array is required and must not be empty' },
				{ status: 400 }
			);
		}

		let deletedCount = 0;
		let removedCount = 0;
		let skippedCount = 0;
		const errors: Array<{ id: string; error: string }> = [];

		for (const seriesId of seriesIds) {
			try {
				// Get series with root folder info
				const [seriesItem] = await db
					.select({
						id: series.id,
						path: series.path,
						rootFolderPath: rootFolders.path,
						rootFolderReadOnly: rootFolders.readOnly
					})
					.from(series)
					.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
					.where(eq(series.id, seriesId));

				if (!seriesItem) {
					errors.push({ id: seriesId, error: 'Series not found' });
					continue;
				}

				// Get files for this series
				const files = await db
					.select()
					.from(episodeFiles)
					.where(eq(episodeFiles.seriesId, seriesId));

				// Skip if no files and not removing from library
				if (files.length === 0 && !removeFromLibrary) {
					skippedCount++;
					continue;
				}

				// Block file deletion from read-only folders
				if (deleteFiles && seriesItem.rootFolderReadOnly) {
					errors.push({ id: seriesId, error: 'Cannot delete files from read-only folder' });
					continue;
				}

				// Delete files from disk if requested
				if (deleteFiles && seriesItem.rootFolderPath && seriesItem.path) {
					await deleteDirectoryWithinRoot(seriesItem.rootFolderPath, seriesItem.path);
				}

				// Delete all episode file records from database
				if (files.length > 0) {
					await db.delete(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));
				}

				if (removeFromLibrary) {
					// Preserve activity audit trail after media rows are deleted (FKs become null on delete)
					await db
						.update(downloadHistory)
						.set({ status: 'removed', statusReason: null })
						.where(eq(downloadHistory.seriesId, seriesId));

					// Delete alternate titles (not cascaded automatically)
					await deleteAllAlternateTitles('series', seriesId);

					// Delete the series from database - CASCADE will handle related records
					await db.delete(series).where(eq(series.id, seriesId));
					removedCount++;
				} else {
					// Update all episodes to hasFile=false
					await db
						.update(episodes)
						.set({ hasFile: false, lastSearchTime: null })
						.where(eq(episodes.seriesId, seriesId));

					// Update all seasons' episode file count to 0
					await db
						.update(seasons)
						.set({ episodeFileCount: 0 })
						.where(eq(seasons.seriesId, seriesId));

					// Update series episode file count
					await db.update(series).set({ episodeFileCount: 0 }).where(eq(series.id, seriesId));

					deletedCount++;
				}
			} catch (error) {
				errors.push({
					id: seriesId,
					error: error instanceof Error ? error.message : 'Unknown error'
				});
			}
		}

		if (deletedCount > 0 || removedCount > 0) {
			libraryMediaEvents.emitLibraryDataChanged({
				source: 'series',
				reason: 'batch-deleted'
			});
		}

		return Response.json({
			success: errors.length === 0,
			deletedCount,
			removedCount,
			skippedCount,
			failedCount: errors.length,
			errors: errors.length > 0 ? errors : undefined
		});
	} catch (error) {
		logger.error(
			'[API] Error batch deleting series files',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to batch delete series files'
			},
			{ status: 500 }
		);
	}
};

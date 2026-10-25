import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { downloadHistory, movies, movieFiles, rootFolders } from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { deleteDirectoryWithinRoot } from '#lib/server/filesystem/delete-helpers.js';
import { deleteAllAlternateTitles } from '#lib/server/services/index.js';
import { monitoringSearchService } from '#lib/server/monitoring/search/MonitoringSearchService.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMoviesBatchApi', logDomain: 'scans' });

/**
 * PATCH /api/library/movies/batch
 * Batch update movie settings (monitored, scoringProfileId)
 *
 * Body:
 * - movieIds: string[] - Array of movie IDs to update
 * - updates: { monitored?: boolean, scoringProfileId?: string | null }
 */
export const PATCH: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { movieIds, updates } = body;

		if (!movieIds || !Array.isArray(movieIds) || movieIds.length === 0) {
			return Response.json(
				{ success: false, error: 'movieIds array is required and must not be empty' },
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

		const result = await db.update(movies).set(updateData).where(inArray(movies.id, movieIds));

		if (updates.scoringProfileId !== undefined) {
			// Fire and forget upgrade search when profile changes
			monitoringSearchService
				.searchForUpgrades({
					movieIds,
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
					movieIds,
					newProfile: updates.scoringProfileId
				},
				'[API] Triggered upgrade search on batch profile change for movies'
			);
		}

		libraryMediaEvents.emitLibraryDataChanged({
			source: 'movie',
			reason: 'batch-updated'
		});

		return Response.json({
			success: true,
			updatedCount: result.changes
		});
	} catch (error) {
		logger.error('[API] Error batch updating movies', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to batch update movies'
			},
			{ status: 500 }
		);
	}
};

// Alias PUT to PATCH for convenience
export const PUT: RequestHandler = PATCH;

/**
 * DELETE /api/library/movies/batch
 * Batch delete movie files
 *
 * Body:
 * - movieIds: string[] - Array of movie IDs to delete files for
 * - deleteFiles?: boolean - Whether to delete files from disk (default: false)
 * - removeFromLibrary?: boolean - Whether to remove movies from library entirely (default: false)
 */
export const DELETE: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { movieIds, deleteFiles = false, removeFromLibrary = false } = body;

		if (!movieIds || !Array.isArray(movieIds) || movieIds.length === 0) {
			return Response.json(
				{ success: false, error: 'movieIds array is required and must not be empty' },
				{ status: 400 }
			);
		}

		let deletedCount = 0;
		let removedCount = 0;
		let skippedCount = 0;
		const errors: Array<{ id: string; error: string }> = [];

		for (const movieId of movieIds) {
			try {
				// Get movie with root folder info
				const [movie] = await db
					.select({
						id: movies.id,
						path: movies.path,
						hasFile: movies.hasFile,
						rootFolderPath: rootFolders.path,
						rootFolderReadOnly: rootFolders.readOnly
					})
					.from(movies)
					.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
					.where(eq(movies.id, movieId));

				if (!movie) {
					errors.push({ id: movieId, error: 'Movie not found' });
					continue;
				}

				// Get files for this movie
				const files = await db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId));

				// Skip if no files and not removing from library
				if (files.length === 0 && !removeFromLibrary) {
					skippedCount++;
					continue;
				}

				// Block file deletion from read-only folders
				if (deleteFiles && movie.rootFolderReadOnly) {
					errors.push({ id: movieId, error: 'Cannot delete files from read-only folder' });
					continue;
				}

				// Delete files from disk if requested
				if (deleteFiles && movie.rootFolderPath && movie.path) {
					await deleteDirectoryWithinRoot(movie.rootFolderPath, movie.path);
				}

				// Delete movie file records from database
				if (files.length > 0) {
					await db.delete(movieFiles).where(eq(movieFiles.movieId, movieId));
				}

				if (removeFromLibrary) {
					// Preserve activity audit trail after media rows are deleted (FKs become null on delete)
					await db
						.update(downloadHistory)
						.set({ status: 'removed', statusReason: null })
						.where(eq(downloadHistory.movieId, movieId));

					// Delete alternate titles (not cascaded automatically)
					await deleteAllAlternateTitles('movie', movieId);

					// Delete the movie from database - CASCADE will handle related records
					await db.delete(movies).where(eq(movies.id, movieId));
					removedCount++;
				} else {
					// Update movie to show as missing
					await db
						.update(movies)
						.set({ hasFile: false, lastSearchTime: null })
						.where(eq(movies.id, movieId));
					deletedCount++;
				}
			} catch (error) {
				errors.push({
					id: movieId,
					error: error instanceof Error ? error.message : 'Unknown error'
				});
			}
		}

		if (deletedCount > 0 || removedCount > 0) {
			libraryMediaEvents.emitLibraryDataChanged({
				source: 'movie',
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
			'[API] Error batch deleting movie files',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to batch delete movie files'
			},
			{ status: 500 }
		);
	}
};

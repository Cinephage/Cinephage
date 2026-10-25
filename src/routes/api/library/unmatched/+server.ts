import type { RequestHandler } from './$types.js';
import { unmatchedFileService } from '#lib/server/library/unmatched-file-service.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';
import type { UnmatchedFilters } from '#lib/types/unmatched.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryUnmatchedApi', logDomain: 'scans' });

/**
 * GET /api/library/unmatched
 * List unmatched files with optional filtering and pagination
 *
 * Query params:
 * - page: number (default: 1)
 * - limit: number (default: 50, max: 100)
 * - mediaType: 'movie' | 'tv' | null
 * - search: string (search in path or parsed title)
 * - groupBy: 'none' | 'immediate' | 'show' (default: 'none')
 * - sortBy: 'discoveredAt' | 'path' | 'parsedTitle'
 * - sortOrder: 'asc' | 'desc'
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
		const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
		const mediaType = url.searchParams.get('mediaType') as 'movie' | 'tv' | null;
		const search = url.searchParams.get('search');
		const groupBy = url.searchParams.get('groupBy') || 'none';
		const sortBy =
			(url.searchParams.get('sortBy') as 'discoveredAt' | 'path' | 'parsedTitle') || 'discoveredAt';
		const sortOrder = (url.searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc';

		const filters: UnmatchedFilters = {};
		if (mediaType) filters.mediaType = mediaType;
		if (search) filters.search = search;

		if (groupBy !== 'none') {
			// Return grouped by folders
			const folders = await unmatchedFileService.getUnmatchedFolders({
				filters,
				groupBy: groupBy as 'immediate' | 'show'
			});

			return Response.json({
				success: true,
				data: {
					folders,
					totalFolders: folders.length,
					totalFiles: folders.reduce((sum, f) => sum + f.fileCount, 0)
				},
				meta: {
					timestamp: new Date().toISOString(),
					filters,
					grouping: groupBy
				}
			});
		}

		// Return flat list with pagination
		const result = await unmatchedFileService.getUnmatchedFiles({
			filters,
			pagination: { page, limit },
			sortBy,
			sortOrder
		});

		return Response.json({
			success: true,
			data: {
				files: result.files,
				pagination: result.pagination
			},
			meta: {
				timestamp: new Date().toISOString(),
				filters
			}
		});
	} catch (error) {
		logger.error(
			'[API] Error fetching unmatched files',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch unmatched files',
				data: null
			},
			{ status: 500 }
		);
	}
};

/**
 * POST /api/library/unmatched
 * Queue processing of all unmatched files (attempt to auto-match them).
 *
 * Matching hundreds of files takes minutes (TMDB lookups + throttling), so
 * this enqueues per-root-folder jobs and returns immediately instead of
 * running the work inline inside the request (#513). Progress is visible
 * through the library jobs/task UI.
 */
export const POST: RequestHandler = async () => {
	try {
		const jobs = libraryJobService.enqueueMatchUnmatchedForAllFolders();

		return Response.json({
			success: true,
			data: {
				queued: true,
				jobCount: jobs.length,
				jobs
			},
			meta: {
				timestamp: new Date().toISOString()
			}
		});
	} catch (error) {
		logger.error(
			'[API] Error queueing unmatched file processing',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to queue unmatched file processing',
				data: null
			},
			{ status: 500 }
		);
	}
};

/**
 * DELETE /api/library/unmatched
 * Batch delete unmatched files
 *
 * Request body:
 * - fileIds: string[] (required)
 * - deleteFromDisk: boolean (default: false)
 */
export const DELETE: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { fileIds, deleteFromDisk = false } = body as {
			fileIds: string[];
			deleteFromDisk?: boolean;
		};

		if (!Array.isArray(fileIds) || fileIds.length === 0) {
			return Response.json(
				{
					success: false,
					error: 'fileIds array is required and must not be empty',
					data: null
				},
				{ status: 400 }
			);
		}

		const result = await unmatchedFileService.deleteUnmatchedFiles(fileIds, deleteFromDisk);

		return Response.json({
			success: result.deleted > 0,
			data: result,
			meta: {
				timestamp: new Date().toISOString()
			}
		});
	} catch (error) {
		logger.error(
			'[API] Error deleting unmatched files',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete unmatched files',
				data: null
			},
			{ status: 500 }
		);
	}
};

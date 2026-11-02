import type { RequestHandler } from './$types.js';
import { createChildLogger } from '#lib/logging/index.js';
import {
	getLibraryStatus,
	type LibraryStatusMap,
	type LibraryStatus
} from '#lib/server/library/status.js';

const logger = createChildLogger({ module: 'LibraryStatusApi', logDomain: 'scans' });

/**
 * POST /api/library/status
 *
 * Batch lookup library status for multiple TMDB IDs.
 * Returns a map of tmdbId -> { inLibrary, hasFile, mediaType, libraryId }
 *
 * Request body:
 * {
 *   tmdbIds: number[],
 *   mediaType?: 'movie' | 'tv' | 'all'  // Filter by type, defaults to 'all'
 * }
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { tmdbIds, mediaType = 'all' } = body as {
			tmdbIds: number[];
			mediaType?: 'movie' | 'tv' | 'all';
		};

		const statusMap = await getLibraryStatus(tmdbIds, mediaType);

		return Response.json({
			success: true,
			status: statusMap
		});
	} catch (error) {
		logger.error('[API] Error fetching library status', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch library status',
				status: {} as LibraryStatusMap
			},
			{ status: 500 }
		);
	}
};

/**
 * GET /api/library/status?tmdbId=123&mediaType=movie
 *
 * Single item lookup (convenience endpoint)
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const tmdbIdParam = url.searchParams.get('tmdbId');
		const mediaType = url.searchParams.get('mediaType') as 'movie' | 'tv' | 'all' | null;

		if (!tmdbIdParam) {
			return Response.json({ success: false, error: 'tmdbId is required' }, { status: 400 });
		}

		const tmdbId = parseInt(tmdbIdParam, 10);
		if (isNaN(tmdbId)) {
			return Response.json({ success: false, error: 'tmdbId must be a number' }, { status: 400 });
		}

		const statusMap = await getLibraryStatus([tmdbId], mediaType ?? 'all');
		const status: LibraryStatus = statusMap[tmdbId] ?? {
			inLibrary: false,
			hasFile: false,
			mediaType: null
		};

		return Response.json({ success: true, status });
	} catch (error) {
		logger.error('[API] Error fetching library status', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch library status'
			},
			{ status: 500 }
		);
	}
};

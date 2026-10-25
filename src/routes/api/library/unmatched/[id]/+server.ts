import type { RequestHandler } from './$types.js';
import { unmatchedFileService } from '#lib/server/library/unmatched-file-service.js';
import type { MatchRequest } from '#lib/types/unmatched.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryUnmatchedByIdApi', logDomain: 'scans' });

/**
 * GET /api/library/unmatched/[id]
 * Get details for a specific unmatched file
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const { id } = params;
		if (!id) {
			return Response.json({ success: false, error: 'Invalid ID', data: null }, { status: 400 });
		}

		const file = await unmatchedFileService.getUnmatchedFileById(id);

		if (!file) {
			return Response.json(
				{ success: false, error: 'Unmatched file not found', data: null },
				{ status: 404 }
			);
		}

		return Response.json({
			success: true,
			data: { file },
			meta: { timestamp: new Date().toISOString() }
		});
	} catch (error) {
		logger.error('[API] Error fetching unmatched file', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch unmatched file',
				data: null
			},
			{ status: 500 }
		);
	}
};

/**
 * POST /api/library/unmatched/[id]
 * Process (re-match) a single unmatched file
 */
export const POST: RequestHandler = async ({ params }) => {
	try {
		const { id } = params;
		if (!id) {
			return Response.json({ success: false, error: 'Invalid ID', data: null }, { status: 400 });
		}

		const result = await unmatchedFileService.processUnmatchedFile(id);

		return Response.json({
			success: result.matched,
			data: result,
			meta: { timestamp: new Date().toISOString() }
		});
	} catch (error) {
		logger.error(
			'[API] Error processing unmatched file',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to process unmatched file',
				data: null
			},
			{ status: 500 }
		);
	}
};

/**
 * PATCH /api/library/unmatched/[id]
 * Manually match an unmatched file to a TMDB entry
 *
 * Request body:
 * - tmdbId: number (required)
 * - mediaType: 'movie' | 'tv' (required)
 * - season?: number (for TV)
 * - episode?: number (for TV)
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const { id } = params;
		if (!id) {
			return Response.json({ success: false, error: 'Invalid ID', data: null }, { status: 400 });
		}

		const body = await request.json();
		const { tmdbId, mediaType, season, episode } = body as {
			tmdbId: number;
			mediaType: 'movie' | 'tv';
			season?: number;
			episode?: number;
		};

		if (!tmdbId || !mediaType) {
			return Response.json(
				{ success: false, error: 'tmdbId and mediaType are required', data: null },
				{ status: 400 }
			);
		}

		// Build episode mapping if TV with explicit season/episode
		const episodeMapping: MatchRequest['episodeMapping'] = {};
		if (mediaType === 'tv' && season !== undefined && episode !== undefined) {
			episodeMapping[id] = { season, episode };
		}

		const result = await unmatchedFileService.matchFiles({
			fileIds: [id],
			tmdbId,
			mediaType,
			...(mediaType === 'tv' && Object.keys(episodeMapping).length > 0 ? { episodeMapping } : {})
		});

		return Response.json({
			success: result.success,
			data: result,
			meta: { timestamp: new Date().toISOString() }
		});
	} catch (error) {
		logger.error('[API] Error matching unmatched file', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to match file',
				data: null
			},
			{ status: 500 }
		);
	}
};

/**
 * DELETE /api/library/unmatched/[id]
 * Remove a file from the unmatched list (optionally delete from disk)
 *
 * Query params:
 * - deleteFile: boolean (default: false)
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
	try {
		const { id } = params;
		if (!id) {
			return Response.json({ success: false, error: 'Invalid ID', data: null }, { status: 400 });
		}

		const deleteFromDisk = url.searchParams.get('deleteFile') === 'true';

		const result = await unmatchedFileService.deleteUnmatchedFiles([id], deleteFromDisk);

		return Response.json({
			success: result.deleted > 0,
			data: result,
			meta: { timestamp: new Date().toISOString() }
		});
	} catch (error) {
		logger.error('[API] Error deleting unmatched file', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete unmatched file',
				data: null
			},
			{ status: 500 }
		);
	}
};

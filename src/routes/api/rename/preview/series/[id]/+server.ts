/**
 * Series Rename Preview API
 *
 * GET /api/rename/preview/series/:id
 * Returns a preview of how files for a specific series would be renamed.
 */

import type { RequestHandler } from './$types';
import { RenamePreviewService } from '#lib/server/library/naming/RenamePreviewService.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'RenamePreviewSeriesApi', logDomain: 'scans' });

/**
 * GET /api/rename/preview/series/:id
 * Get preview of rename for all files in a series
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	try {
		const { id } = params;

		if (!id) {
			return Response.json({ error: 'Series ID is required' }, { status: 400 });
		}

		const service = new RenamePreviewService();
		const result = await service.previewSeries(id);

		return Response.json({ success: true, ...result });
	} catch (error) {
		logger.error(
			{
				seriesId: params.id,
				error: error instanceof Error ? error.message : String(error)
			},
			'[RenamePreview API] Failed to preview series rename'
		);

		return Response.json(
			{
				error: 'Failed to generate series rename preview',
				details: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};

/**
 * Single Album Rename Preview API
 *
 * GET /api/rename/preview/album/:id
 * Returns a dry run of how an album's track files would be renamed.
 */

import type { RequestHandler } from './$types';
import { musicRenameService } from '#lib/server/music/MusicRenameService.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'RenamePreviewAlbumApi', logDomain: 'scans' });

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { id } = event.params;
	if (!id) return Response.json({ error: 'Album ID is required' }, { status: 400 });

	try {
		return Response.json({ success: true, ...musicRenameService.previewAlbum(id) });
	} catch (error) {
		logger.error(
			{ albumId: id, error: error instanceof Error ? error.message : String(error) },
			'[RenamePreview API] Failed to preview album rename'
		);
		return Response.json(
			{
				error: 'Failed to generate album rename preview',
				details: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};

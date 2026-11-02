/**
 * Folder Reorganization API
 *
 * POST /api/rename/reorganize
 * Reorganizes the parent folder for a movie or series to match the current
 * naming configuration. This is a SEPARATE operation from file renaming
 * (see /api/rename/execute) to eliminate the ordering race condition that
 * occurs when folder and file renames are combined.
 *
 * Pattern: Radarr's MoveMovieService / Sonarr's MoveSeriesService.
 */

import type { RequestHandler } from './$types';
import { RenamePreviewService } from '#lib/server/library/naming/RenamePreviewService.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { diskScanService } from '#lib/server/library/disk-scan.js';
import { z } from 'zod';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'RenameReorganizeApi', logDomain: 'scans' });

const reorganizeSchema = z.object({
	mediaId: z.string().min(1, 'mediaId is required'),
	mediaType: z.enum(['movie', 'series'])
});

/**
 * POST /api/rename/reorganize
 * Reorganize the parent folder for a single movie or series.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	if (diskScanService.scanning) {
		return Response.json(
			{ error: 'A library scan is in progress. Wait for it to finish, then retry the rename.' },
			{ status: 409 }
		);
	}

	const { request } = event;
	try {
		const { mediaId, mediaType } = await parseBody(request, reorganizeSchema);

		const service = new RenamePreviewService();
		const result = await service.reorganizeFolder(mediaId, mediaType);

		logger.info(
			{
				mediaId,
				mediaType,
				...result
			},
			'[Reorganize API] Folder reorganization result'
		);

		if (!result.success) {
			return Response.json({ success: false, error: result.error }, { status: 400 });
		}

		libraryMediaEvents.emitLibraryDataChanged({
			source: mediaType === 'series' ? 'series' : 'movie',
			reason: 'folder-reorganized',
			entityId: mediaId
		});

		return Response.json({ ...result, success: true });
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error)
			},
			'[Reorganize API] Failed to reorganize folder'
		);

		return Response.json(
			{
				error: 'Failed to reorganize folder',
				details: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};

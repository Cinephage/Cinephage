/**
 * Batched Folder Reorganization API
 *
 * POST /api/rename/reorganize-batch
 * Reorganizes parent folders for multiple movies or series in a single
 * request. Eliminates the N+1 sequential HTTP calls the rename page
 * previously made (one per media item).
 *
 * Each item is processed independently — a failure on one item does not
 * abort the others. Returns per-item results so the client can report
 * partial success.
 */

import type { RequestHandler } from './$types';
import { RenamePreviewService } from '#lib/server/library/naming/RenamePreviewService.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { diskScanService } from '#lib/server/library/disk-scan.js';
import { z } from 'zod';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import type { ReorganizeBatchResult } from '#lib/library/naming/types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'RenameReorganizeBatchApi', logDomain: 'scans' });

const reorganizeBatchSchema = z.object({
	items: z
		.array(
			z.object({
				mediaId: z.string().min(1),
				mediaType: z.enum(['movie', 'series'])
			})
		)
		.min(1)
		.max(500)
});

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
		const { items } = await parseBody(request, reorganizeBatchSchema);

		// One service call holds the operation lock for the WHOLE batch, so no
		// library scan can interleave between items. Per-item failures are
		// isolated and reported individually.
		const service = new RenamePreviewService();
		const batch = await service.reorganizeFolders(items);

		for (const result of batch.results) {
			if (!result.success) continue;
			libraryMediaEvents.emitLibraryDataChanged({
				source: result.mediaType === 'series' ? 'series' : 'movie',
				reason: 'folder-reorganized',
				entityId: result.mediaId
			});
		}

		logger.info(
			{ total: batch.total, organized: batch.organized, failed: batch.failed },
			'[ReorganizeBatch API] Batch reorganization complete'
		);

		return Response.json({
			success: batch.failed === 0,
			organized: batch.organized,
			failed: batch.failed,
			results: batch.results
		} satisfies ReorganizeBatchResult);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/scan is in progress/i.test(message)) {
			return Response.json({ error: message }, { status: 409 });
		}

		logger.error(
			{
				error
			},
			'[ReorganizeBatch API] Failed to reorganize folders'
		);

		return Response.json(
			{
				error: 'Failed to reorganize folders',
				details: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};

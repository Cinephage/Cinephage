import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

/**
 * Aggregate manual_import jobs into batches for the Activity page's
 * background-imports card. A bulk batch can be thousands of rows, so this
 * returns true totals per batch instead of a page of raw job rows that
 * would silently truncate a large batch's reported counts.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const batches = libraryJobService.summarizeManualImportBatches();
	return Response.json({ success: true, batches });
};

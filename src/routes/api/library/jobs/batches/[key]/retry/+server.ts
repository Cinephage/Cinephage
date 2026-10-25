import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

/** Retry every failed/cancelled job in a manual_import batch at once. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	try {
		const result = libraryJobService.retryBatch(event.params.key);
		return Response.json({ success: true, ...result });
	} catch (error) {
		return Response.json(
			{ success: false, error: error instanceof Error ? error.message : 'Failed to retry batch' },
			{ status: 400 }
		);
	}
};

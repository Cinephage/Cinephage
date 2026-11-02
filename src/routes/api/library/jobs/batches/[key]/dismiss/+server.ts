import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

/** Dismiss a batch without retrying it: the jobs stay as history, marked
 * acknowledged so the Activity page stops flagging them for attention. */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const result = libraryJobService.acknowledgeBatch(event.params.key);
	return Response.json({ success: true, ...result });
};

import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

/** Cancel every queued/running job in a batch. Queued jobs stop immediately;
 * a job already running is flagged but finishes normally (see cancelBatch). */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const result = libraryJobService.cancelBatch(event.params.key);
	return Response.json({ success: true, ...result });
};

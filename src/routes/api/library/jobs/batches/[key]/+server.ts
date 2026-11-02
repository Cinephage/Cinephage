import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

/** Every job in one batch (parentJobId, or a lone job keyed by its own id);
 * used for the "why did it fail" drilldown on the Activity page's card. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const jobs = libraryJobService.listBatchJobs(event.params.key);
	return Response.json({ success: true, jobs });
};

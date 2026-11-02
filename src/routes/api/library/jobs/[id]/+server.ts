import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const job = await libraryJobService.getJob(event.params.id);
	if (!job) return Response.json({ success: false, error: 'Job not found' }, { status: 404 });
	return Response.json({ success: true, job });
};

import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	try {
		const job = await libraryJobService.cancelJob(event.params.id);
		return Response.json({ success: true, job });
	} catch (error) {
		return Response.json(
			{ success: false, error: error instanceof Error ? error.message : 'Failed to cancel job' },
			{ status: 400 }
		);
	}
};

import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { getPlaylistJob } from '#lib/server/music/playlists/jobs.js';

/**
 * GET /api/music/playlists/jobs/[id] — poll one job.
 *
 * The whole job is returned: rows only exist once resolution finished, and the
 * preview reads them from here rather than from a second endpoint that could
 * disagree with the job about what was resolved.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const job = getPlaylistJob(event.params.id);
	if (!job) return Response.json({ error: 'Job not found or expired' }, { status: 404 });

	return Response.json({ success: true, job });
};

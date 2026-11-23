import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { cancelPlaylistJob } from '#lib/server/music/playlists/jobs.js';

/**
 * POST /api/music/playlists/jobs/[id]/cancel — stop between MusicBrainz calls.
 *
 * The flag is checked between albums, so a cancel never leaves a half-written
 * album row: the current add finishes, the rest are skipped.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const job = cancelPlaylistJob(event.params.id);
	if (!job) return Response.json({ error: 'Job not found or expired' }, { status: 404 });

	return Response.json({ success: true, job });
};

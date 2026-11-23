import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { PlaylistError } from '#lib/server/music/playlists/errors.js';
import { resumePlaylistJob } from '#lib/server/music/playlists/jobs.js';

/**
 * POST /api/music/playlists/jobs/[id]/resume — pick a stopped job back up.
 *
 * A job that was interrupted by a restart (or failed on a MusicBrainz outage)
 * re-runs from its stored recipe: resolution comes from the lookup cache and
 * adding is idempotent, so nothing is fetched twice or added twice.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const job = resumePlaylistJob(event.params.id);
		return Response.json({ success: true, job }, { status: 202 });
	} catch (err) {
		if (err instanceof PlaylistError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		throw err;
	}
};

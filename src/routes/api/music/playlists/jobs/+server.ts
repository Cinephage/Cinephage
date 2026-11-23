import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin, requireAuth } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { PlaylistError } from '#lib/server/music/playlists/errors.js';
import { listPlaylistJobs, startResolveJob } from '#lib/server/music/playlists/jobs.js';

const createSchema = z.object({
	url: z.string().trim().min(1).max(2048),
	/** 'album' adds what matched; 'artist' adds every album by each match's artist. */
	scope: z.enum(['album', 'artist', 'features', 'songs']).default('album')
});

/**
 * POST /api/music/playlists/jobs — read a pasted playlist and resolve it.
 *
 * The response is the job, not the albums: fetching a playlist and resolving it
 * against MusicBrainz takes minutes and the browser polls `…/jobs/[id]`. A URL
 * no adapter understands is answered 400 here, before any job exists.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof createSchema>;
	try {
		input = await parseBody(event.request, createSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	try {
		const job = startResolveJob(input.url, input.scope);
		return Response.json({ success: true, job }, { status: 202 });
	} catch (err) {
		if (err instanceof PlaylistError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		throw err;
	}
};

/**
 * GET /api/music/playlists/jobs — the recent imports.
 *
 * A person with a lot of music starts an import and comes back: this is the
 * list they come back to, with each job's phase and outcome.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const limit = Math.min(Number(event.url.searchParams.get('limit') ?? 12) || 12, 50);
	return Response.json({ success: true, jobs: listPlaylistJobs(limit) });
};

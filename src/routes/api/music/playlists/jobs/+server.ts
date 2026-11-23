import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { PlaylistError } from '#lib/server/music/playlists/errors.js';
import { startResolveJob } from '#lib/server/music/playlists/jobs.js';

const createSchema = z.object({
	url: z.string().trim().min(1).max(2048)
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
		const job = startResolveJob(input.url);
		return Response.json({ success: true, job }, { status: 202 });
	} catch (err) {
		if (err instanceof PlaylistError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		throw err;
	}
};

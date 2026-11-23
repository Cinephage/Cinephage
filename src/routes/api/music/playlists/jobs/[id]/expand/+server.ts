import type { RequestHandler } from './$types.js';
import { z } from 'zod';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { PlaylistError } from '#lib/server/music/playlists/errors.js';
import { getPlaylistJob, previewExpansion } from '#lib/server/music/playlists/jobs.js';

const schema = z.object({
	rowIds: z.array(z.string().min(1)).min(1).max(500),
	scope: z.enum(['artist', 'features'])
});

/**
 * POST /api/music/playlists/jobs/[id]/expand — what the selection would add.
 *
 * "Every album by the artist" can mean two hundred albums; the review screen
 * asks this first and shows the count, using the same computation the import
 * will run (and the same cache), so the number is not an estimate.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const parsed = schema.safeParse(await event.request.json().catch(() => null));
	if (!parsed.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 });
	}

	try {
		const job = getPlaylistJob(event.params.id);
		if (!job) throw new PlaylistError('Import job not found or expired', 404);
		const selected = new Set(parsed.data.rowIds);
		const rows = job.rows.filter((row) => selected.has(row.releaseGroupMbid));
		if (rows.length === 0) {
			return Response.json({ error: 'No selected rows to expand' }, { status: 400 });
		}
		const preview = await previewExpansion(rows, parsed.data.scope);
		return Response.json({ success: true, ...preview });
	} catch (err) {
		if (err instanceof PlaylistError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		throw err;
	}
};

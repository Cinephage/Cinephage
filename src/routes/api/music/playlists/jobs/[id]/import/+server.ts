import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { PlaylistError } from '#lib/server/music/playlists/errors.js';
import { startImportJob } from '#lib/server/music/playlists/jobs.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';

const importSchema = z.object({
	/** Release-group mbids the user kept selected in the preview. */
	rowIds: z.array(z.string().uuid()).min(1).max(500),
	libraryId: z.string().trim().min(1).nullable().optional(),
	rootFolderId: z.string().trim().min(1).nullable().optional(),
	qualityProfileId: z.string().trim().min(1).nullable().optional(),
	monitored: z.boolean().optional(),
	searchAfterAdd: z.boolean().optional(),
	/** 'artist' expands each selected album to its artist's discography. */
	scope: z.enum(['album', 'artist', 'features', 'songs']).default('album')
});

/**
 * POST /api/music/playlists/jobs/[id]/import — add the selected albums.
 *
 * Same job, next phase: the preview's rows become pending imports and the
 * browser keeps polling. Albums that already exist come back as `existing`, so
 * running the same import twice is safe.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof importSchema>;
	try {
		input = await parseBody(event.request, importSchema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	if (input.qualityProfileId && !musicProfileService.get(input.qualityProfileId)) {
		return Response.json(
			{ error: `Unknown music quality profile: ${input.qualityProfileId}` },
			{ status: 400 }
		);
	}

	try {
		const job = startImportJob(event.params.id, input.rowIds, {
			libraryId: input.libraryId ?? null,
			rootFolderId: input.rootFolderId ?? null,
			qualityProfileId: input.qualityProfileId ?? null,
			monitored: input.monitored,
			searchAfterAdd: input.searchAfterAdd,
			scope: input.scope
		});
		return Response.json({ success: true, job }, { status: 202 });
	} catch (err) {
		if (err instanceof PlaylistError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		throw err;
	}
};

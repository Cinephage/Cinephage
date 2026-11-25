import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { autoSearchAlbum } from '#lib/server/music/MusicAutoSearch.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

const schema = z.object({
	/** Albums the person selected. */
	ids: z.array(z.string().trim().min(1)).min(1).max(500),
	/** A batch is `limit` albums; the browser loops until `remaining` is 0. */
	offset: z.number().int().min(0).default(0),
	limit: z.number().int().min(1).max(25).default(10)
});

/**
 * POST /api/music/albums/auto-search — grab the best release for each album.
 *
 * This is the bulk form of the album row's "Grab best": the same guard
 * (`autoSearchAlbum` refuses a release that does not carry the album's title),
 * applied to a selection. Albums that already have files are skipped, and the
 * page walks the list in batches because one request that grabbed a hundred
 * albums would time out while doing honest work.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let input: z.infer<typeof schema>;
	try {
		input = await parseBody(event.request, schema);
	} catch (err) {
		return Response.json(
			{ error: 'Invalid request', details: err instanceof Error ? err.message : String(err) },
			{ status: 400 }
		);
	}

	const batch = input.ids.slice(input.offset, input.offset + input.limit);
	const results: Array<{
		albumId: string;
		title: string;
		grabbed: boolean;
		skipped?: string;
		release?: string;
		error?: string;
	}> = [];

	for (const id of batch) {
		const album = musicAlbumService.getAlbum(id);
		if (!album) {
			results.push({ albumId: id, title: '', grabbed: false, error: 'Album not found' });
			continue;
		}
		if (album.streamSource || album.hasFile) {
			results.push({ albumId: id, title: album.title, grabbed: false, skipped: 'already-here' });
			continue;
		}
		try {
			const result = await autoSearchAlbum(album);
			results.push({
				albumId: id,
				title: album.title,
				grabbed: result.grabbed,
				release: result.release,
				error: result.error
			});
		} catch (err) {
			results.push({
				albumId: id,
				title: album.title,
				grabbed: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	const nextOffset = input.offset + batch.length;
	return Response.json({
		success: true,
		processed: batch.length,
		grabbed: results.filter((row) => row.grabbed).length,
		failed: results.filter((row) => row.error).length,
		skipped: results.filter((row) => row.skipped).length,
		nextOffset: nextOffset < input.ids.length ? nextOffset : null,
		remaining: Math.max(0, input.ids.length - nextOffset),
		results
	});
};

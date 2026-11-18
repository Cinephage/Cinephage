import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { isAppError } from '#lib/errors/index.js';
import { musicGrabService } from '#lib/server/music/MusicGrabService.js';

const logger = createChildLogger({ module: 'MusicAlbumGrabApi', logDomain: 'system' });

/**
 * POST /api/music/albums/[id]/grab
 *
 * Grabs one release for an album: the profile's best accepted candidate, or an
 * explicit `releaseGuid` from the search list. The queue row carries the album's
 * `media_item_id`, so the download is attributable without a movie/series row.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	// An empty body is the common case ("grab the best").
	const body = (await event.request.json().catch(() => ({}))) as { releaseGuid?: unknown };
	if (body.releaseGuid !== undefined && typeof body.releaseGuid !== 'string') {
		return Response.json({ error: 'releaseGuid must be a string' }, { status: 400 });
	}

	try {
		const result = await musicGrabService.grabAlbum(event.params.id, {
			releaseGuid: body.releaseGuid as string | undefined
		});
		return Response.json({ success: true, ...result }, { status: 201 });
	} catch (error) {
		if (isAppError(error)) {
			return Response.json(
				{ error: error.message, errorCode: error.code },
				{ status: error.statusCode }
			);
		}
		logger.error(
			{ albumId: event.params.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicGrab] grab failed'
		);
		return Response.json(
			{
				error: 'Could not grab a release',
				details: error instanceof Error ? error.message : String(error)
			},
			{ status: 502 }
		);
	}
};

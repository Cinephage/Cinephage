/**
 * GET /api/user/media-server/avatar/[serverId]
 *
 * Proxies the caller's own linked Jellyfin avatar. Falls back to 404 when
 * the account has no link on that server or the server has no image — the
 * UI renders the initial-letter fallback in that case. The admin key stays
 * server-side; the response is just the image bytes.
 */

import type { RequestHandler } from './$types.js';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const avatar = await mediaServerLinkService.fetchAvatar(locals.user.id, params.serverId);
	if (!avatar) {
		return new Response(null, { status: 404 });
	}

	return new Response(avatar.body, {
		headers: {
			'Content-Type': avatar.contentType,
			'Cache-Control': 'public, max-age=86400'
		}
	});
};

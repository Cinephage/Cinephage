/**
 * GET /api/settings/users/[userId]/media-server/avatar/[serverId]
 *
 * Admin variant of the avatar proxy: serves the avatar of the linked
 * Jellyfin account for any Cinephage account, for the users list and the
 * user detail page.
 */

import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const avatar = await mediaServerLinkService.fetchAvatar(
		event.params.userId,
		event.params.serverId
	);
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

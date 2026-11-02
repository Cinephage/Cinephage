/**
 * Admin-managed media-server links for a specific account.
 *
 * GET    /api/settings/users/[userId]/media-server-link?serverId=
 *        — current link plus, with serverId, that server's user list for the picker
 * POST   /api/settings/users/[userId]/media-server-link  { serverId, serverUserId }
 *        — admin-mediated link (server user must exist)
 * DELETE /api/settings/users/[userId]/media-server-link?serverId=
 *        — unlink
 *
 * Auth: admin only (enforced here; the settings subtree is also gated by the
 * viewer allowlist in hooks.server.ts).
 */

import type { RequestHandler } from './$types.js';
import { parseBody } from '#lib/server/api/validate.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { z } from 'zod';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';

const adminLinkSchema = z.object({
	serverId: z.string().min(1),
	serverUserId: z.string().min(1)
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const userId = event.params.userId;
	const serverId = event.url.searchParams.get('serverId');

	const links = await mediaServerLinkService.getLinks(userId);
	const servers = await mediaServerLinkService.getLinkableServers();

	let users = null;
	if (serverId) {
		users = await mediaServerLinkService.listServerUsers(serverId);
	}

	return Response.json({ success: true, links, servers, users });
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { serverId, serverUserId } = await parseBody(event.request, adminLinkSchema);
	const result = await mediaServerLinkService.adminLink(
		event.params.userId,
		serverId,
		serverUserId
	);

	switch (result.outcome) {
		case 'linked':
			return Response.json({ success: true, link: result.link });
		case 'no-server':
			return Response.json({ success: false, outcome: result.outcome }, { status: 404 });
		case 'unknown-server-user':
			return Response.json({ success: false, outcome: result.outcome }, { status: 404 });
		case 'conflict':
			return Response.json(
				{ success: false, outcome: result.outcome, error: result.message },
				{ status: 409 }
			);
	}
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const serverId = event.url.searchParams.get('serverId');
	if (!serverId) {
		return Response.json({ success: false, error: 'serverId is required' }, { status: 400 });
	}

	const removed = await mediaServerLinkService.unlink(event.params.userId, serverId);
	return Response.json({ success: removed });
};

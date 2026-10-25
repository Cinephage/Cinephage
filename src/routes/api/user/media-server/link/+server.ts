/**
 * Self-service media-server account linking (Jellyfin Quick Connect).
 *
 * GET    /api/user/media-server/link          — own links + linkable servers
 * POST   /api/user/media-server/link          — start pairing { serverId }
 * PUT    /api/user/media-server/link          — poll pairing status { serverId }
 * DELETE /api/user/media-server/link?serverId — unlink own account
 *
 * Auth: any authenticated user; everything is scoped to locals.user.id and
 * pairing secrets never leave the server (the client only sees the code).
 */

import type { RequestHandler } from './$types.js';
import { createChildLogger } from '#lib/logging/index.js';
import { parseBody } from '#lib/server/api/validate.js';
import { z } from 'zod';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';

const logger = createChildLogger({ module: 'UserMediaServerLinkApi', logDomain: 'auth' });

const serverIdSchema = z.object({
	serverId: z.string().min(1, 'serverId is required')
});

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const [links, servers] = await Promise.all([
		mediaServerLinkService.getLinks(locals.user.id),
		mediaServerLinkService.getLinkableServers()
	]);

	return Response.json({ success: true, links, servers });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const { serverId } = await parseBody(request, serverIdSchema);
	const result = await mediaServerLinkService.initiatePairing(locals.user.id, serverId);

	switch (result.outcome) {
		case 'initiated':
			return Response.json({
				success: true,
				code: result.code,
				expiresAt: result.expiresAt
			});
		case 'already-linked':
			return Response.json(
				{ success: false, outcome: result.outcome, link: result.link },
				{ status: 409 }
			);
		case 'quick-connect-disabled':
			return Response.json({ success: false, outcome: result.outcome }, { status: 503 });
		case 'no-server':
			return Response.json({ success: false, outcome: result.outcome }, { status: 404 });
		default:
			logger.warn({ outcome: result.outcome }, '[UserMediaServerLink] initiate failed');
			return Response.json(
				{ success: false, outcome: result.outcome, error: result.message },
				{ status: 502 }
			);
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const { serverId } = await parseBody(request, serverIdSchema);
	const result = await mediaServerLinkService.checkPairing(locals.user.id, serverId);

	switch (result.outcome) {
		case 'pending':
		case 'expired':
		case 'no-pairing':
			return Response.json({ success: true, outcome: result.outcome });
		case 'linked':
			return Response.json({ success: true, outcome: result.outcome, link: result.link });
		case 'conflict':
			return Response.json(
				{ success: false, outcome: result.outcome, error: result.message },
				{ status: 409 }
			);
		default:
			return Response.json(
				{ success: false, outcome: result.outcome, error: result.message },
				{ status: 502 }
			);
	}
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const serverId = url.searchParams.get('serverId');
	if (!serverId) {
		return Response.json({ success: false, error: 'serverId is required' }, { status: 400 });
	}

	const removed = await mediaServerLinkService.unlink(locals.user.id, serverId);
	return Response.json({ success: removed });
};

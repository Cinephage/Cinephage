/**
 * Self-service Plex account linking via Plex PIN approval.
 *
 * POST /api/user/media-server/plex-link            -> { handle, authUrl, expiresAt }
 * PUT  /api/user/media-server/plex-link { handle } -> { outcome: pending | expired | linked
 *                                                       | no-access | conflict }
 *
 * The handle is bound to the requesting account: another session can't
 * complete it. The Plex token stays server-side and is discarded after the
 * identity lookup. Unlinking reuses DELETE /api/user/media-server/link.
 */

import type { RequestHandler } from './$types.js';
import { z } from 'zod';
import { parseBody } from '#lib/server/api/validate.js';
import { createChildLogger } from '#lib/logging/index.js';
import { plexPinService } from '#lib/server/mediaServerLink/PlexPinService.js';
import { fetchPlexAccount } from '#lib/server/mediaServerLink/plexTv.js';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';

const logger = createChildLogger({ module: 'UserPlexLinkApi', logDomain: 'auth' });

const pollSchema = z.object({ handle: z.string().min(1).max(128) });

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}
	if (!(await mediaServerLinkService.hasPlexSignInServer())) {
		return Response.json({ success: false, outcome: 'no-server' }, { status: 404 });
	}

	try {
		const pin = await plexPinService.create({ kind: 'link', userId: locals.user.id });
		return Response.json({ success: true, ...pin });
	} catch (error) {
		logger.warn({ err: error }, '[UserPlexLink] PIN creation failed');
		return Response.json({ success: false, outcome: 'server-error' }, { status: 502 });
	}
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}
	const { handle } = await parseBody(request, pollSchema);

	try {
		const poll = await plexPinService.poll(handle, { kind: 'link', userId: locals.user.id });
		if (poll.outcome !== 'authorized') {
			return Response.json({ success: true, outcome: poll.outcome });
		}

		const account = await fetchPlexAccount(poll.authToken);
		if (!account) {
			return Response.json({ success: true, outcome: 'expired' });
		}

		const result = await mediaServerLinkService.linkPlexAccount(locals.user.id, account);
		switch (result.outcome) {
			case 'linked':
				return Response.json({ success: true, outcome: 'linked', links: result.links });
			case 'no-access':
				return Response.json({ success: false, outcome: 'no-access' }, { status: 403 });
			case 'conflict':
				return Response.json(
					{ success: false, outcome: 'conflict', error: result.message },
					{ status: 409 }
				);
			case 'server-error':
				return Response.json({ success: false, outcome: 'server-error' }, { status: 502 });
		}
	} catch (error) {
		logger.warn({ err: error }, '[UserPlexLink] Poll failed');
		return Response.json({ success: false, outcome: 'server-error' }, { status: 502 });
	}
};

/**
 * Plex sign-in policy.
 *
 * GET /api/settings/users/plex-sign-in            -> { plexSignInEnabled, newUserSignIn }
 * PUT /api/settings/users/plex-sign-in { newUserSignIn }
 *
 * newUserSignIn: whether a Plex sign-in from an account that can reach a
 * configured Plex server but has no linked Cinephage account creates one.
 *
 * Auth: admin only.
 */

import type { RequestHandler } from './$types.js';
import { z } from 'zod';
import { parseBody } from '#lib/server/api/validate.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getSystemSettingsService } from '#lib/server/settings/SystemSettingsService.js';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';

const updateSchema = z.object({ newUserSignIn: z.boolean() });

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const [plexSignInEnabled, newUserSignIn] = await Promise.all([
		mediaServerLinkService.hasPlexSignInServer(),
		getSystemSettingsService().getPlexNewUserSignIn()
	]);
	return Response.json({ success: true, plexSignInEnabled, newUserSignIn });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { newUserSignIn } = await parseBody(event.request, updateSchema);
	await getSystemSettingsService().setPlexNewUserSignIn(newUserSignIn);
	return Response.json({ success: true, newUserSignIn });
};

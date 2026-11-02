/**
 * Admin bulk import of media server users into local accounts.
 *
 * GET  /api/settings/users/media-server-import?serverId=
 *      — supported-server list plus, with serverId, the classified roster
 *        (importable / linked / disabled / blocked-with-reason)
 * POST /api/settings/users/media-server-import  { serverId, serverUserIds }
 *      — create and link the selected accounts; temporary passwords are
 *        generated server-side and returned once, never accepted as input
 *
 * Auth: admin only (enforced here; the settings subtree is also gated by the
 * viewer allowlist in hooks.server.ts).
 */

import type { RequestHandler } from './$types.js';
import { z } from 'zod';
import { parseBody } from '#lib/server/api/validate.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { auth } from '#lib/server/auth/auth.js';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';
import {
	mediaServerUserImportService,
	MAX_IMPORT_BATCH,
	type ImportedUserCreator
} from '#lib/server/mediaServerLink/MediaServerUserImportService.js';

const importSchema = z.object({
	serverId: z.string().min(1),
	serverUserIds: z.array(z.string().min(1)).min(1).max(MAX_IMPORT_BATCH)
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const serverId = event.url.searchParams.get('serverId');
	const servers = await mediaServerLinkService.getLinkableServers();

	let users = null;
	if (serverId) {
		const preview = await mediaServerUserImportService.previewImport(serverId);
		switch (preview.outcome) {
			case 'ok':
				users = preview.users;
				break;
			case 'no-server':
				return Response.json({ success: false, outcome: preview.outcome }, { status: 404 });
			case 'server-error':
				return Response.json({ success: false, outcome: preview.outcome }, { status: 502 });
		}
	}

	return Response.json({ success: true, servers, users });
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { serverId, serverUserIds } = await parseBody(event.request, importSchema);

	// Creation goes through the admin plugin's createUser: the forwarded
	// session headers identify the admin, and the user.create.before hook
	// re-checks the role plus the username policy on every single row.
	const createUser: ImportedUserCreator = async ({ username, email, password }) => {
		const created = await auth.api.createUser({
			body: {
				email,
				password,
				name: username,
				role: 'user',
				data: { username }
			},
			headers: event.request.headers
		});
		return { userId: created.user.id };
	};

	const result = await mediaServerUserImportService.importUsers({
		serverId,
		serverUserIds,
		createUser
	});

	switch (result.outcome) {
		case 'ok':
			return Response.json({ success: true, results: result.results });
		case 'no-server':
			return Response.json({ success: false, outcome: result.outcome }, { status: 404 });
		case 'server-error':
			return Response.json({ success: false, outcome: result.outcome }, { status: 502 });
	}
};

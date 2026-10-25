import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { syncJackettIndexers } from '#lib/server/indexers/jackett/JackettConnectionService.js';

/** POST: trigger an immediate Jackett sync */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await syncJackettIndexers();
		return Response.json({ success: true, result });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : 'Sync failed' },
			{ status: 500 }
		);
	}
};

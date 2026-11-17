import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { listRecentDeliveries } from '#lib/server/notifications/core/connections.js';

/** GET /api/notifications/deliveries?limit=25 — the recent delivery log. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const limit = Number(event.url.searchParams.get('limit') ?? 25);
	const deliveries = await listRecentDeliveries(Number.isFinite(limit) ? limit : 25);
	return Response.json({ deliveries });
};

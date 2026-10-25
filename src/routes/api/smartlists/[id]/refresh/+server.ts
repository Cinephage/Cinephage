/**
 * Smart List Refresh API
 * POST /api/smartlists/[id]/refresh - Manually refresh a smart list
 */

import type { RequestHandler } from './$types';
import { getSmartListService } from '#lib/server/smartlists/index.js';

export const POST: RequestHandler = async ({ params }) => {
	const service = getSmartListService();

	const list = await service.getSmartList(params.id);
	if (!list) {
		return Response.json({ error: 'Smart list not found' }, { status: 404 });
	}

	try {
		const result = await service.refreshSmartList(params.id, 'manual');
		return Response.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};

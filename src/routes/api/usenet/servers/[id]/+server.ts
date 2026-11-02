/**
 * GET /api/usenet/servers/:id - Get a specific NNTP server
 * PUT /api/usenet/servers/:id - Update an NNTP server
 * DELETE /api/usenet/servers/:id - Delete an NNTP server
 */

import type { RequestHandler } from './$types';
import { getNntpServerService } from '#lib/server/streaming/nzb/NntpServerService.js';
import { getNntpManager } from '#lib/server/streaming/usenet/NntpManager.js';
import { nntpServerUpdateSchema } from '#lib/validation/schemas.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

/**
 * GET /api/usenet/servers/:id
 * Get a specific NNTP server by ID.
 */
export const GET: RequestHandler = async ({ params }) => {
	const service = getNntpServerService();
	const server = await service.getServer(params.id);

	if (!server) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	return Response.json(server);
};

/**
 * PUT /api/usenet/servers/:id
 * Update an existing NNTP server.
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = nntpServerUpdateSchema.safeParse(data);

	if (!result.success) {
		return Response.json(
			{
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const service = getNntpServerService();
	const updated = await service.updateServer(params.id, result.data);

	if (!updated) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	await getNntpManager().reload();
	return Response.json({ success: true, server: updated });
};

/**
 * DELETE /api/usenet/servers/:id
 * Delete an NNTP server.
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	const service = getNntpServerService();
	const deleted = await service.deleteServer(params.id);

	if (!deleted) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	await getNntpManager().reload();
	return Response.json({ success: true });
};

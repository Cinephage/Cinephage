import type { RequestHandler } from './$types';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { downloadClientUpdateSchemaForImplementation } from '#lib/validation/schemas.js';
import { assertFound, parseBody } from '#lib/server/api/validate.js';
import { NotFoundError } from '#lib/errors/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

/**
 * GET /api/download-clients/[id]
 * Get a single download client.
 */
export const GET: RequestHandler = async ({ params }) => {
	const manager = getDownloadClientManager();
	const client = await manager.getClient(params.id);

	// Throws NotFoundError if client is null, handled by hooks.server.ts
	return Response.json(assertFound(client, 'Download client', params.id));
};

/**
 * PUT /api/download-clients/[id]
 * Update a download client.
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	const manager = getDownloadClientManager();
	const existing = assertFound(await manager.getClient(params.id), 'Download client', params.id);
	// The stored implementation is authoritative for partial-update validation.
	const data = await parseBody(
		request,
		downloadClientUpdateSchemaForImplementation(existing.implementation)
	);

	try {
		const updated = await manager.updateClient(params.id, data);
		return Response.json({ success: true, client: updated });
	} catch (error) {
		// Re-throw as NotFoundError for proper status code
		if (error instanceof Error && error.message.includes('not found')) {
			throw new NotFoundError('Download client', params.id);
		}
		throw error;
	}
};

/**
 * DELETE /api/download-clients/[id]
 * Delete a download client.
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	const manager = getDownloadClientManager();

	try {
		await manager.deleteClient(params.id);
		return Response.json({ success: true });
	} catch (error) {
		// Re-throw as NotFoundError for proper status code
		if (error instanceof Error && error.message.includes('not found')) {
			throw new NotFoundError('Download client', params.id);
		}
		throw error;
	}
};

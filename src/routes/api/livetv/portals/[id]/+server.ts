/**
 * Live TV Portal API - Single Portal Operations
 *
 * GET    /api/livetv/portals/[id] - Get a portal by ID
 * PATCH  /api/livetv/portals/[id] - Update a portal
 * DELETE /api/livetv/portals/[id] - Delete a portal
 */

import type { RequestHandler } from './$types';
import { getStalkerPortalManager } from '#lib/server/livetv/stalker/index.js';
import { stalkerPortalUpdateSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';

const logger = createChildLogger({ module: 'LiveTvPortalById', logDomain: 'livetv' });

/**
 * Get a portal by ID
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const manager = getStalkerPortalManager();
		const portal = await manager.getPortal(params.id);

		if (!portal) {
			return Response.json(
				{
					success: false,
					error: 'Portal not found'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true,
			portal
		});
	} catch (error) {
		logger.error('[API] Failed to get portal', error instanceof Error ? error : undefined);

		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get portal'
			},
			{ status: 500 }
		);
	}
};

/**
 * Update a portal
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();

		// Validate input
		const parsed = stalkerPortalUpdateSchema.safeParse(body);
		if (!parsed.success) {
			throw new ValidationError('Validation failed', {
				details: parsed.error.flatten()
			});
		}

		const manager = getStalkerPortalManager();
		const portal = await manager.updatePortal(params.id, parsed.data);

		return Response.json({
			success: true,
			portal
		});
	} catch (error) {
		logger.error('[API] Failed to update portal', error instanceof Error ? error : undefined);

		// Validation errors
		if (error instanceof ValidationError) {
			return Response.json(
				{
					success: false,
					error: error.message,
					code: error.code,
					context: error.context
				},
				{ status: error.statusCode }
			);
		}

		const message = error instanceof Error ? error.message : String(error);

		if (message.includes('not found')) {
			return Response.json(
				{
					success: false,
					error: 'Portal not found'
				},
				{ status: 404 }
			);
		}

		if (message.includes('already exists')) {
			return Response.json(
				{
					success: false,
					error: message
				},
				{ status: 409 }
			);
		}

		return Response.json(
			{
				success: false,
				error: message || 'Failed to update portal'
			},
			{ status: 500 }
		);
	}
};

/**
 * Delete a portal
 */
export const DELETE: RequestHandler = async ({ params }) => {
	try {
		const manager = getStalkerPortalManager();
		await manager.deletePortal(params.id);

		return Response.json({
			success: true
		});
	} catch (error) {
		logger.error('[API] Failed to delete portal', error instanceof Error ? error : undefined);

		const message = error instanceof Error ? error.message : String(error);

		if (message.includes('not found')) {
			return Response.json(
				{
					success: false,
					error: 'Portal not found'
				},
				{ status: 404 }
			);
		}

		return Response.json(
			{
				success: false,
				error: message || 'Failed to delete portal'
			},
			{ status: 500 }
		);
	}
};

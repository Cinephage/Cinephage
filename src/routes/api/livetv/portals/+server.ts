/**
 * Live TV Portals API
 *
 * GET  /api/livetv/portals - List all saved portals
 * POST /api/livetv/portals - Create a new portal
 */

import type { RequestHandler } from './$types';
import { getStalkerPortalManager } from '#lib/server/livetv/stalker/index.js';
import { stalkerPortalCreateSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError, isAppError } from '#lib/errors/index.js';

const logger = createChildLogger({ module: 'LiveTvPortals', logDomain: 'livetv' });

/**
 * List all portals
 */
export const GET: RequestHandler = async () => {
	const manager = getStalkerPortalManager();
	const portals = await manager.getPortals();

	return Response.json({
		success: true,
		portals
	});
};

/**
 * Create a new portal
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	// Validate input
	const parsed = stalkerPortalCreateSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError('Validation failed', {
			details: parsed.error.flatten()
		});
	}

	const manager = getStalkerPortalManager();

	// Check if detectType is explicitly set to false
	const detectType = body.detectType !== false;

	try {
		const portal = await manager.createPortal(parsed.data, detectType);

		return Response.json(
			{
				success: true,
				portal
			},
			{ status: 201 }
		);
	} catch (error) {
		logger.error('[API] Failed to create portal', error instanceof Error ? error : undefined);

		// Re-throw ValidationError and AppError for central handler
		if (isAppError(error)) {
			throw error;
		}

		const message = error instanceof Error ? error.message : String(error);

		// Duplicate URL detection
		if (message.includes('already exists') || message.includes('UNIQUE constraint failed')) {
			return Response.json(
				{
					success: false,
					error: 'A portal with this URL already exists'
				},
				{ status: 409 }
			);
		}

		// Generic error - don't leak details
		return Response.json(
			{
				success: false,
				error: 'Failed to create portal'
			},
			{ status: 500 }
		);
	}
};

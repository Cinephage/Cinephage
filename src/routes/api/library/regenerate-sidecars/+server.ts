/**
 * Regenerate Sidecar Files Endpoint
 *
 * Backfills .nfo + poster/fanart sidecars across the whole library,
 * always overwriting existing files - see regenerateSidecars.ts for why
 * this differs from the normal on-import skip-if-exists behavior.
 *
 * POST /api/library/regenerate-sidecars
 */

import type { RequestHandler } from './$types';
import { regenerateSidecars } from '#lib/server/library/sidecar/regenerateSidecars.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'RegenerateSidecarsApi', logDomain: 'imports' });

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		logger.info('[API] Starting sidecar regeneration');
		const result = await regenerateSidecars();

		return Response.json({
			success: true,
			...result
		});
	} catch (error) {
		logger.error('[API] Sidecar regeneration failed', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};

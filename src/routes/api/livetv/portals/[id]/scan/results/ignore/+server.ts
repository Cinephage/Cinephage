/**
 * Portal Scan Results Ignore API
 *
 * POST /api/livetv/portals/[id]/scan/results/ignore - Ignore scan results
 */

import type { RequestHandler } from './$types';
import { getPortalScannerService } from '#lib/server/livetv/stalker/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'LiveTvPortalScanResultsIgnore', logDomain: 'livetv' });

const ignoreSchema = z.object({
	resultIds: z.array(z.string()).min(1)
});

/**
 * Ignore scan results
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();

		// Validate input
		const parsed = ignoreSchema.safeParse(body);
		if (!parsed.success) {
			throw new ValidationError('Validation failed', {
				details: parsed.error.flatten()
			});
		}

		const scannerService = getPortalScannerService();
		await scannerService.ignoreMultiple(parsed.data.resultIds);

		return Response.json({
			success: true,
			ignored: parsed.data.resultIds.length
		});
	} catch (error) {
		logger.error('[API] Failed to ignore scan results', error instanceof Error ? error : undefined);

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

		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to ignore scan results'
			},
			{ status: 500 }
		);
	}
};

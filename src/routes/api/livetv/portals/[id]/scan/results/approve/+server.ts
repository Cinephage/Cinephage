/**
 * Portal Scan Results Approve API
 *
 * POST /api/livetv/portals/[id]/scan/results/approve - Approve scan results
 */

import type { RequestHandler } from './$types';
import { getPortalScannerService } from '#lib/server/livetv/stalker/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'LiveTvPortalScanResultsApprove', logDomain: 'livetv' });

const approveSchema = z.object({
	resultIds: z.array(z.string()).min(1)
});

/**
 * Approve scan results and create accounts
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();

		// Validate input
		const parsed = approveSchema.safeParse(body);
		if (!parsed.success) {
			throw new ValidationError('Validation failed', {
				details: parsed.error.flatten()
			});
		}

		const scannerService = getPortalScannerService();
		const accountIds = await scannerService.approveMultiple(parsed.data.resultIds);

		return Response.json({
			success: true,
			approved: accountIds.length,
			accountIds
		});
	} catch (error) {
		logger.error(
			'[API] Failed to approve scan results',
			error instanceof Error ? error : undefined
		);

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
				error: error instanceof Error ? error.message : 'Failed to approve scan results'
			},
			{ status: 500 }
		);
	}
};

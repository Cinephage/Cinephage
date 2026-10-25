/**
 * System Status API Endpoint
 *
 * Returns the status of all background services.
 * Useful for monitoring startup progress and health checks.
 */

import type { RequestHandler } from './$types.js';
import { serviceManager } from '#lib/server/services/index.js';
import { resolveAppVersion } from '#lib/server/version.js';

export const GET: RequestHandler = async () => {
	const services = serviceManager.getStatus();
	const allReady = serviceManager.allReady();

	return Response.json(
		{
			success: true,
			ready: allReady,
			version: resolveAppVersion(),
			services
		},
		{
			headers: {
				'cache-control': 'no-store, no-cache, must-revalidate'
			}
		}
	);
};

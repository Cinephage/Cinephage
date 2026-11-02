import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { getServiceManager } from '#lib/server/services/service-manager.js';
import { resolveAppVersion } from '#lib/server/version.js';

type HealthCheckResult = {
	status: 'healthy' | 'unhealthy';
	latencyMs?: number;
};

export const GET: RequestHandler = async () => {
	const checks: Record<string, HealthCheckResult> = {};
	let overallHealthy = true;

	// Database check
	const dbStart = performance.now();
	try {
		await db.select().from(settings).limit(1);
		checks.database = {
			status: 'healthy',
			latencyMs: Math.round(performance.now() - dbStart)
		};
	} catch {
		checks.database = { status: 'unhealthy' };
		overallHealthy = false;
	}

	const serviceManager = getServiceManager();
	const servicesStarted = serviceManager.isStarted();
	const status: 'healthy' | 'starting' | 'unhealthy' = !overallHealthy
		? 'unhealthy'
		: servicesStarted
			? 'healthy'
			: 'starting';
	const httpStatus = status === 'unhealthy' ? 503 : 200;

	return Response.json(
		{
			status,
			version: resolveAppVersion(),
			timestamp: new Date().toISOString(),
			runtime: {
				uptimeSeconds: Math.round(process.uptime()),
				servicesStarted
			},
			checks
		},
		{
			status: httpStatus,
			headers: {
				'cache-control': 'no-store, no-cache, must-revalidate'
			}
		}
	);
};

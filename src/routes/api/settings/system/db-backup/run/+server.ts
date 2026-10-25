import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getMonitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const result = await getMonitoringScheduler().runDbBackup();
	return Response.json({ success: true, itemsProcessed: result.itemsProcessed });
};

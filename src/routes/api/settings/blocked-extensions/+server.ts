import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { globalBlockedVideoExtensionsSchema } from '#lib/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	getBlockedVideoExtensions,
	setBlockedVideoExtensions,
	invalidateBlockedVideoExtensionsCache
} from '#lib/server/settings/blocked-extensions.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/DownloadMonitorService.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const data = await getBlockedVideoExtensions();
	return Response.json({ success: true, ...data });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const result = await parseBody(event.request, globalBlockedVideoExtensionsSchema);

	await setBlockedVideoExtensions(result);

	invalidateBlockedVideoExtensionsCache();

	downloadMonitor.checkBlockedExtensions().catch(() => {});

	return Response.json({ success: true, ...result });
};

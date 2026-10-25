import type { RequestHandler } from './$types';
import { getExtractionCacheManager } from '#lib/server/streaming/nzb/extraction/ExtractionCacheManager.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const cacheManager = getExtractionCacheManager();
	const result = await cacheManager.runCleanup();

	return Response.json({
		success: true,
		cleaned: result.cleaned,
		freedMB: Math.round(result.freedBytes / 1024 / 1024)
	});
};

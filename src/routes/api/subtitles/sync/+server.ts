import type { RequestHandler } from './$types';
import { getSubtitleSyncService } from '#lib/server/subtitles/services/SubtitleSyncService.js';
import { subtitleSyncSchema } from '#lib/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';

/**
 * POST /api/subtitles/sync
 * Synchronize a subtitle using alass.
 */
export const POST: RequestHandler = async ({ request }) => {
	const validated = await parseBody(request, subtitleSyncSchema);
	const syncService = getSubtitleSyncService();

	const syncResult = await syncService.syncSubtitle(validated.subtitleId, {
		referenceType: validated.referenceType,
		referencePath: validated.referencePath,
		splitPenalty: validated.splitPenalty,
		noSplits: validated.noSplits
	});

	if (!syncResult.success && syncResult.error?.startsWith('Subtitle not found:')) {
		return Response.json({ error: 'Subtitle not found' }, { status: 404 });
	}

	if (!syncResult.success && syncResult.error === 'Video file not found for syncing') {
		return Response.json({ error: syncResult.error }, { status: 400 });
	}

	return Response.json({
		success: syncResult.success,
		offsetMs: syncResult.offsetMs,
		error: syncResult.error
	});
};

/**
 * GET /api/subtitles/sync
 * Check if alass is available.
 */
export const GET: RequestHandler = async () => {
	const syncService = getSubtitleSyncService();
	const isAvailable = await syncService.isAvailable();

	return Response.json({
		available: isAvailable,
		message: isAvailable
			? 'alass is available'
			: 'alass is not installed. Install with: cargo install alass-cli (or download from https://github.com/kaegi/alass/releases). Set ALASS_PATH env var to specify a custom binary location.'
	});
};

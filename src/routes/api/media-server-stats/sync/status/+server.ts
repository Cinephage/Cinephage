import type { RequestHandler } from './$types.js';
import { createSSEStream } from '#lib/server/sse.js';
import { getMediaServerStatsSyncService } from '#lib/server/mediaServerStats/MediaServerStatsSyncService.js';
import { requireAuth } from '#lib/server/auth/authorization.js';

/**
 * GET /api/media-server-stats/sync/status
 * Server-Sent Events stream for media-server sync state changes.
 *
 * Emits:
 *   - 'status' on connect: { inProgress: boolean }
 *   - 'syncStart' when sync begins (count 0 -> 1)
 *   - 'syncStop'  when sync ends (count 1 -> 0)
 *
 * Mirrors /api/library/scan/status.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const { request } = event;
	const acceptHeader = request.headers.get('accept');
	const wantsSSE = acceptHeader?.includes('text/event-stream');

	const service = getMediaServerStatsSyncService();

	if (!wantsSSE) {
		return new Response(
			JSON.stringify({
				success: true,
				inProgress: service.currentlySyncing
			}),
			{
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}

	return createSSEStream((send) => {
		send('status', { inProgress: service.currentlySyncing });

		const onSyncStart = (data: { timestamp: string }) => {
			send('syncStart', data);
		};

		const onSyncStop = (data: { timestamp: string }) => {
			send('syncStop', data);
		};

		service.on('syncStart', onSyncStart);
		service.on('syncStop', onSyncStop);

		return () => {
			service.off('syncStart', onSyncStart);
			service.off('syncStop', onSyncStop);
		};
	});
};

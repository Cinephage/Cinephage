/**
 * GET /api/streaming/usenet/[mountId]/check
 *
 * Check if a mount's content can be streamed directly.
 * RAR-compressed content is not supported for streaming.
 */
import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { getUsenetStreamService } from '#lib/server/streaming/usenet/UsenetStreamService.js';
import { getNzbMountManager } from '#lib/server/streaming/nzb/NzbMountManager.js';

const logger = createChildLogger({ module: 'UsenetMountCheckApi', logDomain: 'streams' });

export const GET: RequestHandler = async ({ params }) => {
	const { mountId } = params;

	const streamService = getUsenetStreamService();
	const mountManager = getNzbMountManager();

	// Check if service is ready
	if (!streamService.isReady()) {
		logger.warn('[UsenetCheck] Usenet streaming service not ready');
		return Response.json({ error: 'Usenet streaming service not available' }, { status: 503 });
	}

	try {
		// Check streamability
		const streamability = await streamService.checkStreamability(mountId);

		// Update mount with streamability info
		if (streamability.canStream) {
			await mountManager.updateStatus(mountId, 'ready', { streamability });
		} else {
			await mountManager.updateStatus(mountId, 'error', {
				streamability,
				errorMessage: streamability.error
			});
		}

		logger.info(
			{
				mountId,
				canStream: streamability.canStream,
				archiveType: streamability.archiveType
			},
			'[UsenetCheck] Checked streamability'
		);

		return Response.json(streamability);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';

		if (message.includes('not found')) {
			logger.warn({ mountId }, '[UsenetCheck] Mount not found');
			return Response.json({ error: 'Mount not found' }, { status: 404 });
		}

		logger.error({ mountId, error: message }, '[UsenetCheck] Check error');
		return Response.json({ error: message }, { status: 500 });
	}
};

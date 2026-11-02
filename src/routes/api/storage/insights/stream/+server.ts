import { createSSEStream } from '#lib/server/sse.js';
import { storageEvents } from '#lib/server/storage/StorageEvents.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	return createSSEStream((send) => {
		const onDismissed = (data: { insightId: string; dismissedAt: string }) => {
			send('storage:insight-dismissed', data);
		};

		const onUndismissed = (data: { insightId: string }) => {
			send('storage:insight-undismissed', data);
		};

		const onInsightsUpdated = (data: { triggeredBy: string; timestamp: string }) => {
			send('storage:insights-updated', data);
		};

		storageEvents.on('storage:insight-dismissed', onDismissed);
		storageEvents.on('storage:insight-undismissed', onUndismissed);
		storageEvents.on('storage:insights-updated', onInsightsUpdated);

		return () => {
			storageEvents.off('storage:insight-dismissed', onDismissed);
			storageEvents.off('storage:insight-undismissed', onUndismissed);
			storageEvents.off('storage:insights-updated', onInsightsUpdated);
		};
	});
};

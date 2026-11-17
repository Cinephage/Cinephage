import type { PageServerLoad } from './$types.js';
import {
	NotificationConnectionStore,
	listRecentDeliveries
} from '#lib/server/notifications/core/connections.js';
import { listNotificationAgents } from '#lib/server/notifications/core/registry.js';
import { SUBSCRIBABLE_EVENTS } from '#lib/server/notifications/core/events.js';

export const load: PageServerLoad = async ({ url }) => {
	const store = new NotificationConnectionStore();
	const connectionId = url.searchParams.get('connection') ?? undefined;
	const [connections, deliveries] = await Promise.all([
		store.list(),
		listRecentDeliveries(25, connectionId)
	]);

	return {
		connections,
		deliveries,
		selectedConnectionId: connectionId ?? null,
		providers: listNotificationAgents().map((agent) => ({
			id: agent.id,
			label: agent.label,
			fields: agent.fields
		})),
		events: [...SUBSCRIBABLE_EVENTS]
	};
};

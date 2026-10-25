import { EventEmitter } from 'node:events';

/**
 * Live-update signal for request consumers. The SSE route filters by the
 * connected user (admins receive everything; viewers only their own), so
 * payloads carry the affected requester id rather than request bodies.
 */
export interface RequestRefreshPayload {
	/** Which requester's data changed (viewers filter on this). */
	requesterId: string;
	/** Request id when a single request changed. */
	requestId?: string;
	/** Notification-related change (unread badge refresh). */
	notificationForUserIds?: string[];
	timestamp: string;
}

class RequestStreamEvents extends EventEmitter {
	constructor() {
		super();
		// One listener per open SSE connection (the layout bell mounts for
		// every authenticated user); the default 10-cap would spam warnings.
		this.setMaxListeners(0);
	}

	emitRefresh(payload: RequestRefreshPayload): void {
		this.emit('requests:refresh', payload);
	}
}

export const requestStreamEvents = new RequestStreamEvents();

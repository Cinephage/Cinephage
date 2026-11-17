/**
 * Notification event vocabulary.
 *
 * This is the *contract between the app's domain and every external agent*.
 * Adding an event means adding a member here plus a rendering case in
 * `render.ts` and a publisher call site — never a new branch in a provider.
 */

export const NOTIFICATION_EVENTS = [
	'grab',
	'import',
	'upgrade',
	'request_pending',
	'request_approved',
	'request_declined',
	'request_available',
	'request_failed',
	'request_expired',
	'task_failed',
	'test'
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Wildcard stored in a connection's event list: receive everything. */
export const ALL_EVENTS = '*';

/** Events an admin can subscribe a connection to (test is never selectable). */
export const SUBSCRIBABLE_EVENTS = NOTIFICATION_EVENTS.filter(
	(event): event is Exclude<NotificationEvent, 'test'> => event !== 'test'
);

export type NotificationEventKey = (typeof NOTIFICATION_EVENTS)[number];

export interface NotificationMediaRef {
	type: 'movie' | 'series';
	title: string;
	year?: number | null;
	tmdbId?: number | null;
	tvdbId?: number | null;
	/** Absolute poster URL, when the provider gave us a path. */
	posterUrl?: string | null;
}

export interface NotificationEpisodeRef {
	seasonNumber: number;
	episodeNumber: number;
	title?: string | null;
}

export interface NotificationRequestRef {
	id: string;
	/** Display name of the user who submitted the request, when known. */
	requestedBy?: string | null;
	status?: string | null;
	reason?: string | null;
}

/** Context for a scheduled task that failed. */
export interface NotificationTaskRef {
	/** Human label, e.g. "Missing Content Search". */
	name: string;
	error?: string | null;
}

/**
 * Everything an agent can be told about an event. Providers receive only the
 * rendered message; the payload is kept for the delivery log and for agents
 * that need structured data (the generic webhook).
 */
export interface NotificationPayload {
	event: NotificationEvent;
	media?: NotificationMediaRef;
	episodes?: NotificationEpisodeRef[];
	releaseName?: string | null;
	quality?: string | null;
	indexer?: string | null;
	request?: NotificationRequestRef;
	/** Present for `task_failed`. */
	task?: NotificationTaskRef;
	/** Deep link into the app (absolute URL when a base URL is configured). */
	link?: string | null;
	/** Caller-supplied one-line summary, appended to the rendered body. */
	summary?: string | null;
	occurredAt?: string;
}

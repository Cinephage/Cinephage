/**
 * Message rendering — the one place that decides what a notification says.
 *
 * Providers are transport only, so all wording, field selection and colour
 * live here: a new event adds one case, a new provider adds none. Bodies are
 * deliberately English (agents post into third-party services, not the app
 * UI); the in-app feed keeps its own localised copy.
 */

import type { NotificationEvent, NotificationPayload } from './events.js';
import type { RenderedNotification } from './agent.js';

const EVENT_TITLE: Record<NotificationEvent, string> = {
	grab: 'Grabbed',
	import: 'Imported',
	upgrade: 'Upgraded',
	request_pending: 'New request',
	request_approved: 'Request approved',
	request_declined: 'Request declined',
	request_available: 'Request available',
	request_failed: 'Request failed',
	request_expired: 'Request expired',
	task_failed: 'Task failed',
	test: 'Test notification'
};

/** Discord embed colour per event (decimal RGB). */
const EVENT_COLOR: Record<NotificationEvent, number> = {
	grab: 0x3498db,
	import: 0x57f287,
	upgrade: 0x9b59b6,
	request_pending: 0xf1c40f,
	request_approved: 0x57f287,
	request_declined: 0xed4245,
	request_available: 0x1abc9c,
	request_failed: 0xed4245,
	request_expired: 0x95a5a6,
	task_failed: 0xe67e22,
	test: 0x3498db
};

export function eventLabel(event: NotificationEvent): string {
	return EVENT_TITLE[event] ?? 'Notification';
}

export function eventColor(event: NotificationEvent): number {
	return EVENT_COLOR[event] ?? 0x3498db;
}

function formatEpisodes(payload: NotificationPayload): string | null {
	const episodes = payload.episodes ?? [];
	if (episodes.length === 0) return null;
	if (episodes.length > 6) {
		const first = episodes[0];
		const last = episodes[episodes.length - 1];
		return `S${String(first.seasonNumber).padStart(2, '0')}E${String(first.episodeNumber).padStart(2, '0')} – S${String(last.seasonNumber).padStart(2, '0')}E${String(last.episodeNumber).padStart(2, '0')} (${episodes.length} episodes)`;
	}
	return episodes
		.map(
			(episode) =>
				`S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}${
					episode.title ? ` ${episode.title}` : ''
				}`
		)
		.join(', ');
}

function mediaSubject(payload: NotificationPayload): string | null {
	const media = payload.media;
	if (!media) return null;
	return media.year ? `${media.title} (${media.year})` : media.title;
}

/**
 * Builds the message one event becomes. `subject` falls back through media,
 * release name and request so a notification is never blank.
 */
export function renderNotification(payload: NotificationPayload): RenderedNotification {
	const subject = mediaSubject(payload) ?? payload.releaseName ?? payload.task?.name ?? null;
	const heading = eventLabel(payload.event);
	const title =
		payload.event === 'test'
			? 'Cinephage test notification'
			: subject
				? `${heading}: ${subject}`
				: heading;

	const fields: Array<{ name: string; value: string }> = [];
	const media = payload.media;
	if (media) {
		fields.push({
			name: 'Media',
			value: media.year ? `${media.title} (${media.year})` : media.title
		});
	}
	const episodes = formatEpisodes(payload);
	if (episodes) fields.push({ name: 'Episodes', value: episodes });
	if (payload.quality) fields.push({ name: 'Quality', value: payload.quality });
	if (payload.releaseName && payload.releaseName !== subject) {
		fields.push({ name: 'Release', value: payload.releaseName });
	}
	if (payload.indexer) fields.push({ name: 'Indexer', value: payload.indexer });
	if (payload.request?.requestedBy) {
		fields.push({ name: 'Requested by', value: payload.request.requestedBy });
	}
	if (payload.request?.reason) fields.push({ name: 'Reason', value: payload.request.reason });
	if (payload.task?.error) fields.push({ name: 'Error', value: payload.task.error });

	const lines: string[] = [];
	if (payload.summary) lines.push(payload.summary);
	if (payload.task?.error) lines.push(payload.task.error);
	if (payload.event === 'test') {
		lines.push('This is a test notification from Cinephage. Your agent is configured correctly.');
	}
	if (lines.length === 0) {
		const fallback = fields.find((field) => field.name !== 'Media');
		if (fallback) lines.push(`${fallback.name}: ${fallback.value}`);
		else lines.push('Cinephage event');
	}

	return {
		event: payload.event,
		title,
		body: lines.join('\n'),
		color: eventColor(payload.event),
		imageUrl: payload.media?.posterUrl ?? null,
		url: payload.link ?? null,
		fields,
		timestamp: payload.occurredAt ?? new Date().toISOString()
	};
}

/** The canned message used by "Test" on a connection. */
export function renderTestNotification(): RenderedNotification {
	return renderNotification({ event: 'test', occurredAt: new Date().toISOString() });
}

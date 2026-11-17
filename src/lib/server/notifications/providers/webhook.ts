/**
 * Generic JSON webhook agent.
 *
 * Posts a stable, documented payload — the same shape for every event — so a
 * receiver can key on `event` and read `media`/`episodes` without parsing
 * prose. This is the integration point for Home Assistant, n8n, Notifiarr
 * bridges and anything else that speaks HTTP.
 */

import {
	type AgentConfig,
	type AgentResult,
	type NotificationAgent,
	type RenderedNotification,
	normalizeBaseUrl,
	resultFromResponse,
	stringField,
	withTimeout
} from '../core/agent.js';
import type { NotificationPayload } from '../core/events.js';

async function post(
	config: AgentConfig,
	message: RenderedNotification,
	payload: NotificationPayload
): Promise<AgentResult> {
	const url = stringField(config, 'url');
	if (!url) return { ok: false, error: 'Webhook URL is not configured' };

	const method = stringField(config, 'method') === 'PUT' ? 'PUT' : 'POST';
	const authorization = stringField(config, 'authorization');

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'x-cinephage-event': message.event
	};
	if (authorization) headers.authorization = authorization;

	const body = JSON.stringify({
		event: message.event,
		title: message.title,
		message: message.body,
		url: message.url ?? null,
		media: payload.media ?? null,
		episodes: payload.episodes ?? [],
		request: payload.request ?? null,
		quality: payload.quality ?? null,
		releaseName: payload.releaseName ?? null,
		indexer: payload.indexer ?? null,
		timestamp: message.timestamp,
		instance: 'Cinephage'
	});

	const attempt = await withTimeout((signal) => fetch(url, { method, headers, body, signal }));
	if (!attempt.ok || !attempt.value) {
		return { ok: false, status: attempt.status, error: attempt.error ?? 'Request failed' };
	}
	return resultFromResponse(attempt.value);
}

export const webhookAgent: NotificationAgent = {
	id: 'webhook',
	label: 'Webhook',
	fields: [
		{
			key: 'url',
			labelKey: 'notifications_field_webhookUrl',
			type: 'url',
			required: true,
			placeholder: 'https://example.com/hooks/cinephage'
		},
		{
			key: 'method',
			labelKey: 'notifications_field_method',
			type: 'select',
			default: 'POST',
			options: [
				{ value: 'POST', labelKey: 'notifications_option_post' },
				{ value: 'PUT', labelKey: 'notifications_option_put' }
			]
		},
		{
			key: 'authorization',
			labelKey: 'notifications_field_authorization',
			type: 'password',
			secret: true,
			helpKey: 'notifications_help_authorization',
			placeholder: 'Bearer …'
		}
	],
	send: post,
	async test(config, message) {
		return post(config, message, { event: 'test' });
	}
};

/** Exported for the API: normalises a base URL the same way for every agent. */
export { normalizeBaseUrl };

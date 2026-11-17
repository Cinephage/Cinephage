/**
 * Pushover agent — mobile push through Pushover's message API.
 *
 * Pushover's limits are enforced by the API, not by us: title 250 chars,
 * message 1024. Truncating here keeps a long episode list from turning a
 * delivery into a 400 that reads like a broken agent.
 */

import {
	type AgentConfig,
	type AgentResult,
	type NotificationAgent,
	type RenderedNotification,
	numberField,
	resultFromResponse,
	stringField,
	withTimeout
} from '../core/agent.js';

const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';

function clampTitle(value: string): string {
	return value.length > 250 ? `${value.slice(0, 247)}…` : value;
}

function clampMessage(value: string): string {
	return value.length > 1024 ? `${value.slice(0, 1021)}…` : value;
}

async function post(config: AgentConfig, message: RenderedNotification): Promise<AgentResult> {
	const token = stringField(config, 'token');
	const user = stringField(config, 'user');
	if (!token || !user) {
		return { ok: false, error: 'Pushover application token and user key are both required' };
	}

	const form = new URLSearchParams({
		token,
		user,
		title: clampTitle(message.title),
		message: clampMessage(message.body),
		priority: String(Math.max(-2, Math.min(1, numberField(config, 'priority', 0))))
	});
	if (message.url) {
		form.set('url', message.url);
		form.set('url_title', 'Open Cinephage');
	}
	const sound = stringField(config, 'sound');
	if (sound) form.set('sound', sound);

	const attempt = await withTimeout((signal) =>
		fetch(PUSHOVER_ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
			signal
		})
	);
	if (!attempt.ok || !attempt.value) {
		return { ok: false, status: attempt.status, error: attempt.error ?? 'Request failed' };
	}
	return resultFromResponse(attempt.value);
}

export const pushoverAgent: NotificationAgent = {
	id: 'pushover',
	label: 'Pushover',
	fields: [
		{
			key: 'token',
			labelKey: 'notifications_field_pushoverToken',
			type: 'password',
			secret: true,
			required: true,
			helpKey: 'notifications_help_pushoverToken'
		},
		{
			key: 'user',
			labelKey: 'notifications_field_pushoverUser',
			type: 'password',
			secret: true,
			required: true,
			helpKey: 'notifications_help_pushoverUser'
		},
		{
			key: 'priority',
			labelKey: 'notifications_field_pushoverPriority',
			type: 'select',
			default: '0',
			options: [
				{ value: '-2', labelKey: 'notifications_option_prioritySilent' },
				{ value: '-1', labelKey: 'notifications_option_priorityQuiet' },
				{ value: '0', labelKey: 'notifications_option_priorityNormal' },
				{ value: '1', labelKey: 'notifications_option_priorityHigh' }
			]
		},
		{
			key: 'sound',
			labelKey: 'notifications_field_pushoverSound',
			type: 'text',
			helpKey: 'notifications_help_pushoverSound',
			placeholder: 'pushover'
		}
	],
	send: (config, message) => post(config, message),
	test: (config, message) => post(config, message)
};

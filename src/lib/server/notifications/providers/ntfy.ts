/**
 * ntfy agent — publishes to a topic on ntfy.sh or a self-hosted server.
 *
 * ntfy takes the title as a header, which must be ASCII; a non-ASCII title
 * goes into the body instead so a Unicode show title cannot fail the send.
 */

import {
	type AgentConfig,
	type AgentResult,
	type NotificationAgent,
	type RenderedNotification,
	numberField,
	normalizeBaseUrl,
	resultFromResponse,
	stringField,
	withTimeout
} from '../core/agent.js';

const DEFAULT_SERVER = 'https://ntfy.sh';

function isAscii(value: string): boolean {
	return /^[\x20-\x7e]*$/.test(value);
}

async function post(config: AgentConfig, message: RenderedNotification): Promise<AgentResult> {
	const topic = stringField(config, 'topic');
	if (!topic) return { ok: false, error: 'ntfy topic is not configured' };

	const base = normalizeBaseUrl(stringField(config, 'serverUrl') || DEFAULT_SERVER);
	const headers: Record<string, string> = {
		'content-type': 'text/plain',
		priority: String(Math.max(1, Math.min(5, numberField(config, 'priority', 3)))),
		tags:
			message.event === 'request_failed' || message.event === 'request_declined'
				? 'warning'
				: 'cinema'
	};
	const token = stringField(config, 'token');
	if (token) headers.authorization = `Bearer ${token}`;

	let body = message.body;
	if (isAscii(message.title)) {
		headers.title = message.title;
	} else {
		body = `${message.title}\n\n${body}`;
	}
	if (message.url) headers.click = message.url;
	if (message.imageUrl) headers.icon = message.imageUrl;

	const attempt = await withTimeout((signal) =>
		fetch(`${base}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body, signal })
	);
	if (!attempt.ok || !attempt.value) {
		return { ok: false, status: attempt.status, error: attempt.error ?? 'Request failed' };
	}
	return resultFromResponse(attempt.value);
}

export const ntfyAgent: NotificationAgent = {
	id: 'ntfy',
	label: 'ntfy',
	fields: [
		{
			key: 'serverUrl',
			labelKey: 'notifications_field_ntfyServer',
			type: 'url',
			placeholder: DEFAULT_SERVER,
			helpKey: 'notifications_help_ntfyServer'
		},
		{
			key: 'topic',
			labelKey: 'notifications_field_ntfyTopic',
			type: 'text',
			required: true,
			helpKey: 'notifications_help_ntfyTopic'
		},
		{
			key: 'token',
			labelKey: 'notifications_field_ntfyToken',
			type: 'password',
			secret: true,
			helpKey: 'notifications_help_ntfyToken'
		},
		{
			key: 'priority',
			labelKey: 'notifications_field_ntfyPriority',
			type: 'select',
			default: '3',
			options: [
				{ value: '1', labelKey: 'notifications_option_priorityMin' },
				{ value: '2', labelKey: 'notifications_option_priorityLow' },
				{ value: '3', labelKey: 'notifications_option_priorityNormal' },
				{ value: '4', labelKey: 'notifications_option_priorityHigh' },
				{ value: '5', labelKey: 'notifications_option_priorityMax' }
			]
		}
	],
	send: (config, message) => post(config, message),
	test: (config, message) => post(config, message)
};

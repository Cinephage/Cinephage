/**
 * Discord agent — posts an embed to a channel webhook.
 *
 * The webhook URL is a capability (anyone holding it can post), so it is
 * stored encrypted and redacted like a password.
 */

import {
	type AgentConfig,
	type AgentResult,
	type NotificationAgent,
	type RenderedNotification,
	resultFromResponse,
	stringField,
	withTimeout
} from '../core/agent.js';
import type { NotificationPayload } from '../core/events.js';

async function post(config: AgentConfig, message: RenderedNotification): Promise<AgentResult> {
	const webhookUrl = stringField(config, 'webhookUrl');
	if (!webhookUrl) return { ok: false, error: 'Discord webhook URL is not configured' };

	const username = stringField(config, 'username');
	const payload: Record<string, unknown> = {
		embeds: [
			{
				title: message.title,
				description: message.body,
				color: message.color,
				url: message.url ?? undefined,
				fields: message.fields.map((field) => ({
					name: field.name,
					value: field.value.slice(0, 1024),
					inline: true
				})),
				timestamp: message.timestamp,
				footer: { text: 'Cinephage' }
			}
		]
	};
	if (username) payload.username = username;

	const attempt = await withTimeout((signal) =>
		fetch(webhookUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal
		})
	);
	if (!attempt.ok || !attempt.value) {
		return { ok: false, status: attempt.status, error: attempt.error ?? 'Request failed' };
	}
	return resultFromResponse(attempt.value);
}

export const discordAgent: NotificationAgent = {
	id: 'discord',
	label: 'Discord',
	fields: [
		{
			key: 'webhookUrl',
			labelKey: 'notifications_field_discordWebhook',
			type: 'password',
			secret: true,
			required: true,
			helpKey: 'notifications_help_discordWebhook',
			placeholder: 'https://discord.com/api/webhooks/…'
		},
		{
			key: 'username',
			labelKey: 'notifications_field_discordUsername',
			type: 'text',
			placeholder: 'Cinephage'
		}
	],
	send: (config, message) => post(config, message),
	test: (config, message) => post(config, message)
};

export type { NotificationPayload };

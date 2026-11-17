/**
 * Agent registry — the single composition point for providers.
 *
 * Adding a provider is one module plus one entry in this map. Nothing else
 * in the codebase (delivery, API, UI) branches on provider id, so a new
 * transport needs no edits outside its own file.
 */

import type { NotificationAgent } from './agent.js';
import { discordAgent } from '../providers/discord.js';
import { ntfyAgent } from '../providers/ntfy.js';
import { pushoverAgent } from '../providers/pushover.js';
import { webhookAgent } from '../providers/webhook.js';

export const NOTIFICATION_AGENTS: readonly NotificationAgent[] = [
	webhookAgent,
	discordAgent,
	pushoverAgent,
	ntfyAgent
];

const BY_ID = new Map(NOTIFICATION_AGENTS.map((agent) => [agent.id, agent]));

export function getNotificationAgent(id: string): NotificationAgent | undefined {
	return BY_ID.get(id);
}

export function listNotificationAgents(): readonly NotificationAgent[] {
	return NOTIFICATION_AGENTS;
}

export function isNotificationProviderId(id: string): boolean {
	return BY_ID.has(id);
}

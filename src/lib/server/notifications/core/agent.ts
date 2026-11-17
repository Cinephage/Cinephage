/**
 * External notification agents.
 *
 * An agent is *transport only*: it declares the fields an admin fills in and
 * turns one rendered message into one HTTP call. Content decisions (what a
 * "Grab" says, which colour it gets) live in `render.ts`, so adding a
 * provider never touches the event vocabulary and adding an event never
 * touches a provider.
 */

import type { NotificationEvent, NotificationPayload } from './events.js';

export type AgentFieldType = 'text' | 'password' | 'url' | 'select' | 'number' | 'boolean';

export interface AgentFieldOption {
	value: string;
	/** Paraglide message key for the option label. */
	labelKey: string;
}

export interface AgentField {
	key: string;
	/** Paraglide message key for the field label. */
	labelKey: string;
	type: AgentFieldType;
	required?: boolean;
	/** Placeholder shown in the form (never a real credential). */
	placeholder?: string;
	/** Paraglide message key for the help text under the field. */
	helpKey?: string;
	options?: AgentFieldOption[];
	default?: string | number | boolean;
	/**
	 * Encrypted at rest and redacted in API responses. A blank value on update
	 * means "keep the stored secret".
	 */
	secret?: boolean;
}

/** Provider configuration as stored in `notification_connections.config`. */
export type AgentConfig = Record<string, unknown>;

export interface AgentResult {
	ok: boolean;
	status?: number;
	error?: string;
}

/** The single message shape every provider renders. */
export interface RenderedNotification {
	event: NotificationEvent;
	title: string;
	body: string;
	/** Discord embed colour, decimal RGB. */
	color?: number;
	/** Absolute link back into Cinephage, when one can be built. */
	url?: string | null;
	fields: Array<{ name: string; value: string }>;
	timestamp: string;
}

export interface NotificationAgent {
	/** Stable id stored in `notification_connections.provider`. */
	id: string;
	/** Human-readable provider name (product name, not translated). */
	label: string;
	fields: AgentField[];
	/** Posts `message` using `config`. Never throws — failures come back as `ok: false`. */
	send(
		config: AgentConfig,
		message: RenderedNotification,
		payload: NotificationPayload
	): Promise<AgentResult>;
	/** Sends the canned test message. Same contract as `send`. */
	test(config: AgentConfig, message: RenderedNotification): Promise<AgentResult>;
}

/** Shared timeout for every outbound agent call. */
export const AGENT_TIMEOUT_MS = 10_000;

/** Reads a string field with trimming, returning '' for anything unusable. */
export function stringField(config: AgentConfig, key: string): string {
	const value = config[key];
	return typeof value === 'string' ? value.trim() : '';
}

/** Reads a numeric field with a fallback. */
export function numberField(config: AgentConfig, key: string, fallback: number): number {
	const value = Number(config[key]);
	return Number.isFinite(value) ? value : fallback;
}

/** Trims a base URL and strips a trailing slash so paths can be appended. */
export function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, '');
}

/**
 * Wraps an outbound call so a slow or dead endpoint can never hold the
 * publisher open, and so every provider reports failures the same way.
 */
export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<{
	ok: boolean;
	status?: number;
	error?: string;
	value?: T;
}> {
	try {
		const value = await run(AbortSignal.timeout(AGENT_TIMEOUT_MS));
		return { ok: true, value };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			typeof (error as { status?: unknown })?.status === 'number'
				? (error as { status: number }).status
				: undefined;
		return { ok: false, status, error: message };
	}
}

/** Maps an HTTP response to an AgentResult, keeping a slice of the body. */
export async function resultFromResponse(response: Response): Promise<AgentResult> {
	if (response.ok) return { ok: true, status: response.status };
	let body = '';
	try {
		body = (await response.text()).slice(0, 300);
	} catch {
		// A body that cannot be read is not a second failure worth reporting.
	}
	return {
		ok: false,
		status: response.status,
		error: body ? `${response.status} ${body}` : `HTTP ${response.status}`
	};
}

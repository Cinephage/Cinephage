/**
 * plex.tv account API: PIN-based sign-in and token identity.
 *
 * Plex sign-in works the way Seerr's does - a PIN is created on plex.tv,
 * the user approves it in Plex's own popup (app.plex.tv/auth), and the PIN
 * then carries a Plex auth token. Unlike Seerr, the PIN is created and
 * polled from this server, so the token never reaches the browser (the
 * page CSP keeps connect-src at 'self' anyway). The token is used once to
 * read the account's identity and is then discarded.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';

export const PLEX_TV = 'https://plex.tv';
const PLEX_AUTH_APP = 'https://app.plex.tv/auth';
const REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_IDENTIFIER_KEY = 'plex_client_identifier';
const PRODUCT = 'Cinephage';

let clientIdentifier: string | null = null;

/**
 * Stable per-install X-Plex-Client-Identifier. A PIN can only be polled by
 * the client that created it, and Plex lists approved sign-ins as devices
 * under this id, so it must survive restarts.
 */
export async function getPlexClientIdentifier(): Promise<string> {
	if (clientIdentifier) return clientIdentifier;

	const existing = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, CLIENT_IDENTIFIER_KEY))
		.get();
	if (existing?.value) {
		clientIdentifier = existing.value;
		return clientIdentifier;
	}

	const generated = `cinephage-${randomUUID()}`;
	await db
		.insert(settings)
		.values({ key: CLIENT_IDENTIFIER_KEY, value: generated })
		.onConflictDoNothing();
	// Re-read: a concurrent first call may have won the insert.
	const stored = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, CLIENT_IDENTIFIER_KEY))
		.get();
	clientIdentifier = stored?.value ?? generated;
	return clientIdentifier;
}

async function plexTvFetch(
	path: string,
	init: { method?: string; token?: string } = {}
): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'X-Plex-Product': PRODUCT,
		'X-Plex-Client-Identifier': await getPlexClientIdentifier()
	};
	if (init.token) headers['X-Plex-Token'] = init.token;
	return fetch(`${PLEX_TV}${path}`, {
		method: init.method ?? 'GET',
		headers,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});
}

export type PlexPin = { id: number; code: string };

export async function createPlexPin(): Promise<PlexPin> {
	const response = await plexTvFetch('/api/v2/pins?strong=true', { method: 'POST' });
	if (!response.ok) {
		throw new Error(`plex.tv PIN creation returned ${response.status}`);
	}
	const body = (await response.json()) as { id?: number; code?: string };
	if (typeof body.id !== 'number' || !body.code) {
		throw new Error('Malformed plex.tv PIN response');
	}
	return { id: body.id, code: body.code };
}

/** 'pending' until approved; null once plex.tv no longer knows the PIN. */
export async function checkPlexPin(
	pinId: number
): Promise<{ authToken: string } | 'pending' | null> {
	const response = await plexTvFetch(`/api/v2/pins/${pinId}`);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`plex.tv PIN check returned ${response.status}`);
	}
	const body = (await response.json()) as { authToken?: string | null };
	return body.authToken ? { authToken: body.authToken } : 'pending';
}

export async function buildPlexAuthUrl(code: string): Promise<string> {
	const params = new URLSearchParams({
		clientID: await getPlexClientIdentifier(),
		code,
		'context[device][product]': PRODUCT
	});
	return `${PLEX_AUTH_APP}#?${params.toString()}`;
}

export type PlexAccount = {
	id: string;
	username: string | null;
	title: string | null;
	email: string | null;
};

/** Identity behind a Plex token, or null when plex.tv rejects the token. */
export async function fetchPlexAccount(token: string): Promise<PlexAccount | null> {
	const response = await plexTvFetch('/api/v2/user', { token });
	if (response.status === 401 || response.status === 403) return null;
	if (!response.ok) {
		throw new Error(`plex.tv account lookup returned ${response.status}`);
	}
	const body = (await response.json()) as {
		id?: number | string;
		username?: string;
		title?: string;
		email?: string;
	};
	if (body.id == null) return null;
	return {
		id: String(body.id),
		username: body.username?.trim() || null,
		title: body.title?.trim() || null,
		email: body.email?.trim() || null
	};
}

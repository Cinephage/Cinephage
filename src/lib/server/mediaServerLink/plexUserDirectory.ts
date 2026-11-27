/**
 * Plex user directory.
 *
 * A Plex Media Server has no local user list of its own: accounts live on
 * plex.tv. The roster for one server is therefore assembled from plex.tv
 * using the server's configured token (the owner's token):
 *
 *   - the owner, from /api/v2/user (only when it matches the server's
 *     myPlexUsername, so a non-owner token never claims ownership). Plex
 *     servers usually report the owner's email there, not the username,
 *     so the match accepts either.
 *   - shared friends and managed Plex Home users, from /api/users (XML),
 *     narrowed to the accounts that actually have this server shared -
 *     identified by the server's machineIdentifier
 *
 * Every entry is keyed by its plex.tv account id. Unlike Jellyfin, Plex
 * accounts carry a real email address (managed Home users excepted), which
 * the import prefers over a placeholder.
 */

import { XMLParser } from 'fast-xml-parser';
import type { MediaBrowserServerRecord } from '#lib/server/db/schema.js';
import type { ServerUserOption } from './MediaServerLinkService.js';

const PLEX_TV = 'https://plex.tv';
const REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_IDENTIFIER = 'cinephage-link';

const XML_PARSER = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	parseTagValue: false,
	isArray: (name) => name === 'User' || name === 'Server'
});

type PlexTvUser = {
	id?: string;
	title?: string;
	username?: string;
	email?: string;
	home?: string;
	Server?: Array<{ machineIdentifier?: string; pending?: string }>;
};

function plexHeaders(token: string, accept: 'json' | 'xml'): Record<string, string> {
	return {
		Accept: accept === 'json' ? 'application/json' : 'application/xml',
		'X-Plex-Token': token,
		'X-Plex-Client-Identifier': CLIENT_IDENTIFIER,
		'X-Plex-Product': 'Cinephage'
	};
}

async function plexFetch(url: string, token: string, accept: 'json' | 'xml'): Promise<Response> {
	return fetch(url, {
		headers: plexHeaders(token, accept),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});
}

/** machineIdentifier + owning plex.tv username, from the server's root. */
async function fetchServerIdentity(
	server: MediaBrowserServerRecord
): Promise<{ machineIdentifier: string; ownerUsername: string | null }> {
	const response = await plexFetch(`${server.host.replace(/\/+$/, '')}/`, server.apiKey, 'xml');
	if (!response.ok) {
		throw new Error(`Plex server root returned ${response.status}`);
	}
	const parsed = XML_PARSER.parse(await response.text()) as {
		MediaContainer?: { machineIdentifier?: string; myPlexUsername?: string };
	};
	const machineIdentifier = parsed.MediaContainer?.machineIdentifier;
	if (!machineIdentifier) {
		throw new Error('Plex server root has no machineIdentifier');
	}
	return { machineIdentifier, ownerUsername: parsed.MediaContainer?.myPlexUsername || null };
}

function displayName(entry: { username?: string; title?: string }): string | null {
	// Managed Home users have no plex.tv username, only a title.
	return entry.username?.trim() || entry.title?.trim() || null;
}

/**
 * Plex roster for one server. Throws on any upstream failure; the caller
 * maps that to a server-error outcome.
 */
export async function listPlexServerUsers(
	server: MediaBrowserServerRecord
): Promise<ServerUserOption[]> {
	const [{ machineIdentifier, ownerUsername }, accountResponse, usersResponse] = await Promise.all([
		fetchServerIdentity(server),
		plexFetch(`${PLEX_TV}/api/v2/user`, server.apiKey, 'json'),
		plexFetch(`${PLEX_TV}/api/users`, server.apiKey, 'xml')
	]);
	if (!accountResponse.ok) {
		throw new Error(`plex.tv account lookup returned ${accountResponse.status}`);
	}
	if (!usersResponse.ok) {
		throw new Error(`plex.tv user list returned ${usersResponse.status}`);
	}

	const roster: ServerUserOption[] = [];

	const account = (await accountResponse.json()) as {
		id?: number | string;
		username?: string;
		title?: string;
		email?: string;
	};
	const accountName = displayName(account);
	const ownerIdentity = ownerUsername?.trim().toLowerCase() ?? null;
	const tokenIsOwner =
		ownerIdentity === null ||
		[account.username, account.email, account.title].some(
			(value) => value?.trim().toLowerCase() === ownerIdentity
		);
	if (account.id != null && accountName && tokenIsOwner) {
		roster.push({
			id: String(account.id),
			name: accountName,
			isAdministrator: true,
			isDisabled: false,
			email: account.email || null
		});
	}

	const parsed = XML_PARSER.parse(await usersResponse.text()) as {
		MediaContainer?: { User?: PlexTvUser[] };
	};
	for (const entry of parsed.MediaContainer?.User ?? []) {
		const name = displayName(entry);
		if (!entry.id || !name || roster.some((existing) => existing.id === entry.id)) {
			continue;
		}

		const share = entry.Server?.find((s) => s.machineIdentifier === machineIdentifier);
		const isHome = entry.home === '1';
		// Friends only count when this server is shared with them; Home
		// members reach the owner's servers through the Home itself.
		if (!share && !isHome) {
			continue;
		}

		roster.push({
			id: entry.id,
			name,
			isAdministrator: false,
			// An invite that was never accepted grants no access yet.
			isDisabled: share?.pending === '1',
			email: entry.email || null
		});
	}

	return roster;
}

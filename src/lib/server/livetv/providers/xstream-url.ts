import type { XstreamConfig } from '#lib/types/livetv.js';

const XTREAM_ENDPOINT_FILES = new Set(['get.php', 'xmltv.php', 'player_api.php', 'panel_api.php']);

/**
 * Normalize user-supplied XStream URL input.
 *
 * Supports users pasting:
 * - Server root (recommended): http://host:port
 * - Endpoint URLs: get.php, xmltv.php, player_api.php
 *
 * Returns a clean server base path without trailing slash and without endpoint file names.
 */
export function normalizeXstreamBaseUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;

	try {
		const parsed = new URL(trimmed);
		let pathname = parsed.pathname.replace(/\/+$/, '');

		const lastSegment = pathname.split('/').filter(Boolean).pop()?.toLowerCase();
		if (lastSegment && XTREAM_ENDPOINT_FILES.has(lastSegment)) {
			pathname = pathname.slice(0, -lastSegment.length).replace(/\/+$/, '');
		}

		return `${parsed.origin}${pathname}`;
	} catch {
		// Fallback for unexpected non-URL strings.
		return trimmed.replace(/[?#].*$/, '').replace(/\/+$/, '');
	}
}

/**
 * Build a robust player_api.php URL from XStream config and params.
 */
export function buildXstreamPlayerApiUrl(
	config: Pick<XstreamConfig, 'baseUrl' | 'username' | 'password'>,
	params: Record<string, string | number | boolean | null | undefined> = {}
): string {
	const normalizedBaseUrl = normalizeXstreamBaseUrl(config.baseUrl);
	const url = new URL('player_api.php', `${normalizedBaseUrl}/`);
	url.searchParams.set('username', config.username);
	url.searchParams.set('password', config.password);

	for (const [key, value] of Object.entries(params)) {
		if (value === null || value === undefined) continue;
		url.searchParams.set(key, String(value));
	}

	return url.toString();
}

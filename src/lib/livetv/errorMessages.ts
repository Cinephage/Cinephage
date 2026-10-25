import type { LiveTvProviderType } from '#lib/types/livetv.js';

function extractHttpStatus(raw: string): number | null {
	const match = raw.match(/\bHTTP\s+(\d{3})\b/i) ?? raw.match(/\b(\d{3})\b/);
	if (!match) return null;
	const status = Number.parseInt(match[1], 10);
	return Number.isFinite(status) ? status : null;
}

function getProviderLabel(providerType?: LiveTvProviderType): string {
	switch (providerType) {
		case 'm3u':
			return 'playlist';
		case 'xstream':
			return 'XStream server';
		case 'stalker':
			return 'Stalker portal';
		default:
			return 'provider';
	}
}

/**
 * Normalize Live TV test errors into user-friendly messages for UI surfaces.
 */
export function toFriendlyLiveTvTestError(
	error?: string | null,
	providerType?: LiveTvProviderType
): string {
	const raw = (error ?? '').trim();
	if (!raw) {
		return 'Connection test failed. Please review the settings and try again.';
	}

	const msg = raw.toLowerCase();
	const providerLabel = getProviderLabel(providerType);
	const status = extractHttpStatus(raw);

	if (msg.includes('account not found')) {
		return 'Live TV account not found. Refresh the page and try again.';
	}

	if (
		msg.includes('timed out') ||
		msg.includes('timeout') ||
		msg.includes('aborterror') ||
		msg.includes('request timed out')
	) {
		return `Connection timed out while contacting the ${providerLabel}. Check URL and network access.`;
	}

	if (
		msg.includes('fetch failed') ||
		msg.includes('failed to fetch') ||
		msg.includes('failed to connect') ||
		msg.includes('econnrefused') ||
		msg.includes('enotfound') ||
		msg.includes('ehostunreach') ||
		msg.includes('network error')
	) {
		return `Unable to reach the ${providerLabel}. Check host, port, protocol (http/https), and firewall.`;
	}

	if (
		msg.includes('authentication failed') ||
		msg.includes('invalid credentials') ||
		msg.includes('unauthorized') ||
		msg.includes('forbidden')
	) {
		return 'Authentication failed. Check username/password or access token.';
	}

	if (status === 401 || status === 403) {
		return 'Authentication failed. Verify credentials and account permissions.';
	}

	if (status === 404) {
		if (providerType === 'm3u') {
			return 'Playlist URL was not found (HTTP 404). Check the full M3U URL and any required base path.';
		}
		return 'Endpoint not found (HTTP 404). Check the base URL/path for this provider.';
	}

	if (status !== null && status >= 500) {
		return `The ${providerLabel} returned a server error (HTTP ${status}). Try again shortly or check provider status.`;
	}

	if (providerType === 'm3u' && msg.includes('no m3u url or file content')) {
		return 'Provide an M3U playlist URL or upload playlist content before testing.';
	}

	if (providerType === 'm3u' && msg.includes('empty xmltv response')) {
		return 'The EPG URL responded but returned empty data. Check that the XMLTV source is valid.';
	}

	if (providerType === 'm3u' && msg.includes('invalid xmltv')) {
		return 'EPG URL is reachable, but it did not return valid XMLTV data.';
	}

	return raw;
}

/**
 * URL Utilities
 *
 * Provides consistent base URL resolution for .strm files and proxy URLs.
 * This ensures URLs work correctly when accessed from external devices.
 */

import { getStreamingIndexerSettings } from './settings';
import { logger } from '#lib/logging/index.js';
import { isTrustedOrigin } from '#lib/server/utils/origin.js';

// Cache the database baseUrl to avoid repeated DB queries on every request
let cachedBaseUrl: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

const streamLog = { logDomain: 'streams' as const };

function forwardedPrefix(request: Request): string {
	const value = getFirstForwardedHeaderValue(request.headers.get('x-forwarded-prefix'));
	if (!value || !value.startsWith('/') || value.includes('?') || value.includes('#')) return '';
	return `/${value.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
}

function getFirstForwardedHeaderValue(value: string | null): string | null {
	if (!value) return null;
	return (
		value
			.split(',')
			.map((part) => part.trim())
			.find((part) => part.length > 0) ?? null
	);
}

function getTrustedForwardedHeaders(request: Request): {
	host: string | null;
	proto: string;
	prefix: string;
} {
	let trusted = false;
	try {
		trusted = isTrustedOrigin(new URL(request.url).origin);
	} catch {
		// Fall back to the request URL when it is malformed.
	}

	if (!trusted) return { host: null, proto: 'http', prefix: '' };

	const host = getFirstForwardedHeaderValue(request.headers.get('x-forwarded-host'));
	const protoCandidate = getFirstForwardedHeaderValue(request.headers.get('x-forwarded-proto'));
	return {
		host,
		proto: protoCandidate === 'http' || protoCandidate === 'https' ? protoCandidate : 'https',
		prefix: host ? forwardedPrefix(request) : ''
	};
}

function addForwardedPrefix(baseUrl: string, prefix: string): string {
	if (!prefix) return baseUrl;
	const base = new URL(baseUrl);
	const pathname = base.pathname.replace(/\/+$/, '');
	if (pathname === prefix || pathname.endsWith(prefix)) return base.toString().replace(/\/$/, '');
	base.pathname = `${pathname}${prefix}`;
	return base.toString().replace(/\/$/, '');
}

/** Resolve an application route beneath a configured or proxy-provided mount path. */
export function appendBasePath(baseUrl: string, path: string): string {
	const base = new URL(baseUrl);
	const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
	const pathname = match?.[1] ?? path;
	const prefix = base.pathname.replace(/\/+$/, '');
	base.pathname = `${prefix}/${pathname.replace(/^\/+/, '')}`;
	base.search = match?.[2] ?? '';
	base.hash = match?.[3] ?? '';
	return base.toString();
}

/**
 * Check if a URL is a localhost/loopback address that won't work for external clients.
 */
function isLocalhostUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		return (
			host === 'localhost' ||
			host === '127.0.0.1' ||
			host === '::1' ||
			host === '[::1]' ||
			host.startsWith('127.')
		);
	} catch {
		return false;
	}
}

/**
 * Get the base URL for generating stream URLs (synchronous version).
 * Uses cached database value, falls back to request-based resolution.
 *
 * Priority:
 * 1. Cached database baseUrl (from Cinephage Stream indexer settings)
 * 2. X-Forwarded headers (for reverse proxy setups like nginx/traefik)
 * 3. Request URL (fallback to request origin)
 *
 * @param request - The incoming request object
 * @returns The base URL to use for generating stream/proxy URLs
 */
export function getBaseUrl(request: Request): string {
	const {
		host: forwardedHost,
		proto: forwardedProto,
		prefix
	} = getTrustedForwardedHeaders(request);

	// 1. Check cached database value
	if (cachedBaseUrl && Date.now() < cacheExpiry) {
		return addForwardedPrefix(cachedBaseUrl, prefix);
	}

	// 2. Check for reverse proxy headers
	if (forwardedHost) {
		return `${forwardedProto}://${forwardedHost}${prefix}`;
	}

	// 3. Fallback to request URL origin
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}`;
}

/**
 * Get the base URL for generating stream URLs (async version).
 * Fetches from database and updates cache.
 *
 * Priority:
 * 1. Database baseUrl (from Cinephage Stream indexer settings)
 * 2. X-Forwarded headers (for reverse proxy setups like nginx/traefik)
 * 3. Request URL (fallback to request origin)
 *
 * Note: Localhost URLs will work for local testing but not for external clients.
 * Users should configure an external URL in the Cinephage Stream indexer settings
 * for streaming to work from external devices.
 *
 * @param request - The incoming request object
 * @returns The base URL to use for generating stream/proxy URLs
 */
export async function getBaseUrlAsync(request: Request): Promise<string> {
	const {
		host: forwardedHost,
		proto: forwardedProto,
		prefix
	} = getTrustedForwardedHeaders(request);

	// 1. Check database settings (and update cache)
	const settings = await getStreamingIndexerSettings();
	if (settings?.baseUrl) {
		const baseUrl = settings.baseUrl.replace(/\/$/, '');

		// Warn about localhost but allow it (useful for local testing)
		if (isLocalhostUrl(baseUrl)) {
			logger.warn(
				{
					configuredUrl: baseUrl,
					hint: 'Configure Cinephage Server Address in Settings -> Integrations -> Indexers -> Cinephage Stream',
					...streamLog
				},
				'Streaming base URL is set to localhost - this will not work for external clients'
			);
		}

		cachedBaseUrl = baseUrl;
		cacheExpiry = Date.now() + CACHE_TTL_MS;
		return addForwardedPrefix(baseUrl, prefix);
	}

	// 2. Check for reverse proxy headers
	if (forwardedHost) {
		const proxyUrl = `${forwardedProto}://${forwardedHost}${prefix}`;
		return proxyUrl;
	}

	// 3. Fallback to request URL origin
	const url = new URL(request.url);
	const fallbackUrl = `${url.protocol}//${url.host}`;

	if (isLocalhostUrl(fallbackUrl)) {
		logger.warn(
			{
				requestUrl: request.url,
				hint: 'Settings -> Integrations -> Indexers -> Cinephage Stream -> Cinephage Server Address',
				...streamLog
			},
			'Using localhost URL for streaming - configure Cinephage Server Address for external access'
		);
	}

	return fallbackUrl;
}

/**
 * Streaming Module Constants
 *
 * Centralized configuration values for the streaming system.
 * These can be overridden via environment variables where applicable.
 */

// =============================================================================
// HTTP Request Configuration
// =============================================================================

/** Default timeout for HTTP requests in milliseconds */
export const DEFAULT_TIMEOUT_MS = 15000;

/** Short timeout for availability checks in milliseconds */
export const AVAILABILITY_CHECK_TIMEOUT_MS = 5000;

/** Default User-Agent for HTTP requests */
export const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// =============================================================================
// Proxy Configuration
// =============================================================================

/** Proxy fetch timeout in milliseconds (default 30s) */
export const PROXY_FETCH_TIMEOUT_MS = parseInt(process.env.PROXY_FETCH_TIMEOUT_MS || '30000', 10);

/** Maximum segment size in bytes (default 50MB) */
export const PROXY_SEGMENT_MAX_SIZE = parseInt(
	process.env.PROXY_SEGMENT_MAX_SIZE || String(50 * 1024 * 1024),
	10
);

/** Maximum retry attempts for proxy fetches on 5xx errors */
export const PROXY_MAX_RETRIES = parseInt(process.env.PROXY_MAX_RETRIES || '2', 10);

/** Default referer for proxy requests */
export const DEFAULT_PROXY_REFERER = process.env.DEFAULT_PROXY_REFERER || 'https://videasy.net';

/** Referer mappings for different stream domains */
export const PROXY_REFERER_MAP: Record<string, string> = {
	vidlink: 'https://vidlink.pro',
	vidsrc: 'https://vidsrc.to',
	videasy: 'https://videasy.net',
	hexa: 'https://hexawatch.to',
	smashystream: 'https://smashystream.top',
	xprime: 'https://xprime.tv'
};

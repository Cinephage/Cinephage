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

/**
 * Default referer for the legacy URL-based proxy.
 *
 * Empty means "send no Referer header". That is the safe default: the gateway
 * supplies the exact per-provider header set, and newer providers reject a
 * request carrying a Referer (or Origin) they did not ask for. Only set this
 * when every proxied request genuinely needs one.
 */
export const DEFAULT_PROXY_REFERER = process.env.DEFAULT_PROXY_REFERER || '';

/**
 * Referer mappings for the legacy proxy, matched by hostname substring.
 *
 * Deliberately limited to providers that require a Referer: adding one for a
 * provider that does not is indistinguishable from inventing it. Dead
 * providers (videasy) are not listed.
 */
export const PROXY_REFERER_MAP: Record<string, string> = {
	vidlink: 'https://vidlink.pro',
	vidsrc: 'https://vidsrc.to',
	cno: 'https://cno.to/',
	vidy: 'https://www.vidy.st/',
	hexa: 'https://hexawatch.to',
	smashystream: 'https://smashystream.top',
	xprime: 'https://xprime.tv'
};

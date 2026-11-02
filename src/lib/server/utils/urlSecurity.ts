/**
 * URL Security Utilities
 *
 * Provides functions for safely handling URLs that may contain sensitive
 * information like API keys, passwords, and tokens.
 */

/**
 * Sensitive URL parameter names that should be redacted.
 * Case-insensitive matching is used.
 */
const SENSITIVE_PARAMS = [
	'apikey',
	'api_key',
	'api-key',
	'password',
	'passwd',
	'pwd',
	'secret',
	'token',
	'access_token',
	'auth',
	'authorization',
	'key',
	'credential',
	'session',
	'cookie'
];

/**
 * Redact sensitive parameters from a URL for safe logging/display.
 * Replaces sensitive parameter values with '[REDACTED]'.
 *
 * @param url - The URL to redact
 * @returns The URL with sensitive parameters redacted
 *
 * @example
 * redactUrl('https://example.com/api?apikey=secret123&name=test')
 * // Returns: 'https://example.com/api?apikey=[REDACTED]&name=test'
 */
export function redactUrl(url: string): string {
	if (!url) return url;

	try {
		const parsed = new URL(url);
		let hasRedactions = false;

		for (const [key] of parsed.searchParams) {
			const lowerKey = key.toLowerCase();
			// Magnet `tr=` values are themselves announce URLs that often carry a
			// passkey query parameter; recurse so those are redacted too.
			if (lowerKey === 'tr' || lowerKey === 'xs') {
				const value = parsed.searchParams.get(key);
				if (value) {
					const nested = redactUrl(value);
					if (nested !== value) {
						parsed.searchParams.set(key, nested);
						hasRedactions = true;
					}
				}
				continue;
			}
			if (SENSITIVE_PARAMS.some((param) => lowerKey.includes(param))) {
				parsed.searchParams.set(key, '[REDACTED]');
				hasRedactions = true;
			}
		}

		// Also check for Basic auth in URL (user:pass@host)
		if (parsed.username || parsed.password) {
			parsed.username = parsed.username ? '[REDACTED]' : '';
			parsed.password = parsed.password ? '[REDACTED]' : '';
			hasRedactions = true;
		}

		return hasRedactions ? parsed.toString() : url;
	} catch {
		// If URL parsing fails, do a simple regex-based redaction
		return url.replace(
			/([?&])(apikey|api_key|api-key|password|secret|token|key)=([^&]*)/gi,
			'$1$2=[REDACTED]'
		);
	}
}

/**
 * Check if a URL contains sensitive parameters.
 *
 * @param url - The URL to check
 * @returns true if the URL contains sensitive parameters
 */
export function urlContainsSensitiveData(url: string): boolean {
	if (!url) return false;

	try {
		const parsed = new URL(url);

		// Check query parameters
		for (const [key] of parsed.searchParams) {
			const lowerKey = key.toLowerCase();
			if (SENSITIVE_PARAMS.some((param) => lowerKey.includes(param))) {
				return true;
			}
		}

		// Check for credentials in URL
		if (parsed.username || parsed.password) {
			return true;
		}

		return false;
	} catch {
		// Fallback regex check
		return /[?&](apikey|api_key|api-key|password|secret|token|key)=/i.test(url);
	}
}

/**
 * Strip all query parameters from a URL.
 * Useful when you need the base URL without any parameters.
 *
 * @param url - The URL to strip
 * @returns The URL without query parameters
 */
export function stripQueryParams(url: string): string {
	if (!url) return url;

	try {
		const parsed = new URL(url);
		parsed.search = '';
		return parsed.toString();
	} catch {
		// Fallback: strip everything after ?
		const queryIndex = url.indexOf('?');
		return queryIndex !== -1 ? url.substring(0, queryIndex) : url;
	}
}

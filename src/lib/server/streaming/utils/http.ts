/**
 * Shared HTTP Utilities for Stream Extractors
 *
 * Provides common HTTP functionality used across all extractors.
 */

import {
	DEFAULT_TIMEOUT_MS,
	DEFAULT_USER_AGENT,
	AVAILABILITY_CHECK_TIMEOUT_MS
} from '../constants';

export interface FetchOptions {
	/** Request timeout in milliseconds */
	timeout?: number;
	/** Referer header value */
	referer?: string;
	/** HTTP method (defaults to GET) */
	method?: 'GET' | 'HEAD' | 'POST';
	/** Request body for POST requests */
	body?: string;
	/** Additional headers to include */
	headers?: Record<string, string>;
}

/**
 * Fetch with timeout and standard headers for stream extraction.
 *
 * Automatically includes:
 * - User-Agent header
 * - Accept header for HTML/XML
 * - Abort controller for timeout handling
 * - Optional Referer header
 *
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @returns The Response object
 * @throws Error if request times out or fails
 */
export async function fetchWithTimeout(url: string, options: FetchOptions = {}): Promise<Response> {
	const { timeout = DEFAULT_TIMEOUT_MS, referer, method = 'GET', body, headers = {} } = options;

	const requestHeaders: HeadersInit = {
		'User-Agent': DEFAULT_USER_AGENT,
		Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		...headers
	};

	if (referer) {
		requestHeaders['Referer'] = referer;
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			method,
			headers: requestHeaders,
			body,
			signal: controller.signal
		});

		clearTimeout(timeoutId);
		return response;
	} catch (error) {
		clearTimeout(timeoutId);

		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(`Request timeout after ${timeout}ms: ${url}`, { cause: error });
		}

		throw error;
	}
}

/**
 * Check if a stream URL is accessible.
 *
 * Performs a HEAD request with a short timeout to verify the stream is working.
 * Progressive (mp4) liveness checks that must distinguish real media from a
 * provider decoy should use the session proxy's ranged HEAD probe instead.
 *
 * @param url - The stream URL to check
 * @param referer - Optional referer header
 * @returns 'working' if accessible, 'down' if not
 */
export async function checkStreamAvailability(
	url: string,
	referer?: string
): Promise<'working' | 'down'> {
	try {
		const response = await fetchWithTimeout(url, {
			method: 'HEAD',
			timeout: AVAILABILITY_CHECK_TIMEOUT_MS,
			referer
		});
		return response.ok ? 'working' : 'down';
	} catch {
		return 'down';
	}
}

/**
 * Check if a stream URL returns valid HLS content.
 *
 * Fetches the URL and checks if the response contains HLS markers.
 *
 * @param url - The stream URL to check
 * @param referer - Optional referer header
 * @returns 'working' if valid HLS, 'down' if not
 */
export async function checkHlsAvailability(
	url: string,
	referer?: string
): Promise<'working' | 'down'> {
	try {
		const response = await fetchWithTimeout(url, {
			timeout: AVAILABILITY_CHECK_TIMEOUT_MS,
			referer
		});

		if (!response.ok) {
			return 'down';
		}

		const text = await response.text();
		return text.includes('#EXTM3U') || text.includes('#EXT-X') ? 'working' : 'down';
	} catch {
		return 'down';
	}
}

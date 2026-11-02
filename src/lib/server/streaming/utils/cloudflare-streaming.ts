/**
 * Cloudflare-aware Streaming Utilities
 *
 * Provides streaming-specific Cloudflare bypass with cookie persistence.
 * Unlike the indexer cloudflare-fetch, this is optimized for HLS streaming:
 * - Caches Cloudflare sessions per domain
 * - Reuses cookies for playlist and segment requests
 * - Falls back to direct fetch if Cloudflare bypass fails
 */

import { logger } from '#lib/logging/index.js';
import { browserFetch, captchaSolverSettingsService } from '#lib/server/captcha/index.js';
import { fetchWithTimeout } from './http';
import type { FetchOptions } from './http';
import { DEFAULT_USER_AGENT } from '../constants';

const streamLog = { logDomain: 'streams' as const, component: 'CloudflareStreaming' };

// ============================================================================
// Session Cache
// ============================================================================

interface CloudflareSession {
	cookies: string;
	userAgent: string;
	timestamp: number;
}

/** Cache of Cloudflare sessions per domain */
const sessionCache = new Map<string, CloudflareSession>();

/** Session TTL in milliseconds (10 minutes) */
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Get cached session for a domain if it exists and is not expired
 */
export function getCachedSession(domain: string): CloudflareSession | null {
	const session = sessionCache.get(domain);
	if (!session) return null;

	if (Date.now() - session.timestamp > SESSION_TTL_MS) {
		sessionCache.delete(domain);
		return null;
	}

	return session;
}

/**
 * Cache a Cloudflare session for a domain
 */
function cacheSession(domain: string, cookies: string, userAgent: string): void {
	sessionCache.set(domain, {
		cookies,
		userAgent,
		timestamp: Date.now()
	});

	logger.debug(
		{
			domain,
			cookieLength: cookies.length,
			...streamLog
		},
		'Cached Cloudflare session for streaming domain'
	);
}

// ============================================================================
// Cloudflare Detection
// ============================================================================

/**
 * Check if a response indicates Cloudflare protection
 */
function isCloudflareResponse(response: Response, body: string): boolean {
	// Check status codes
	if (response.status !== 403 && response.status !== 503) {
		return false;
	}

	// Check for Cloudflare headers
	const headers = response.headers;
	if (
		headers.get('cf-ray') ||
		headers.get('cf-mitigated') ||
		headers.get('server')?.includes('cloudflare')
	) {
		return true;
	}

	// Check body content
	const lowerBody = body.toLowerCase();
	if (
		lowerBody.includes('cloudflare') ||
		lowerBody.includes('cf-browser-verification') ||
		lowerBody.includes('checking your browser')
	) {
		return true;
	}

	return false;
}

// ============================================================================
// Cloudflare-aware Fetch
// ============================================================================

/**
 * Fetch with automatic Cloudflare bypass for streaming.
 *
 * This function:
 * 1. Tries a normal fetch first
 * 2. If Cloudflare is detected and Camoufox is available, uses browser fetch
 * 3. For streaming URLs, first visits the referer site to get clearance cookies
 * 4. Caches the Cloudflare session for reuse
 * 5. Returns the response with proper headers for subsequent requests
 *
 * @param url - URL to fetch
 * @param options - Fetch options including referer
 * @returns Response object
 */
export async function fetchWithCloudflareBypass(
	url: string,
	options: FetchOptions = {}
): Promise<Response> {
	const domain = new URL(url).hostname;
	const referer = options.referer;

	// Check if we have a cached session for this domain
	const cachedSession = getCachedSession(domain);
	if (cachedSession) {
		logger.debug({ domain, ...streamLog }, 'Using cached Cloudflare session');

		// Try with cached cookies first
		const response = await fetchWithTimeout(url, {
			...options,
			headers: {
				...options.headers,
				Cookie: cachedSession.cookies,
				'User-Agent': cachedSession.userAgent
			}
		});

		if (response.ok) {
			logger.debug({ domain, ...streamLog }, 'Cached Cloudflare session succeeded');
			return response;
		}

		// Cached session expired, clear it
		logger.debug(
			{
				domain,
				status: response.status,
				...streamLog
			},
			'Cached Cloudflare session failed and will be cleared'
		);
		sessionCache.delete(domain);
	}

	// Try normal fetch first
	logger.debug({ domain, url, referer, ...streamLog }, 'Attempting direct streaming fetch');
	const response = await fetchWithTimeout(url, options);

	// If successful or not Cloudflare, return as-is
	if (response.ok) {
		return response;
	}

	// Read body to check for Cloudflare
	const body = await response.text();

	if (!isCloudflareResponse(response, body)) {
		// Not Cloudflare, return the response (re-create it since we read the body)
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}

	// Cloudflare detected - check if solver is enabled
	const config = captchaSolverSettingsService.getConfig();
	if (!config.enabled) {
		logger.warn(
			{
				domain,
				url,
				...streamLog
			},
			'Cloudflare detected for streaming request but solver is disabled'
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}

	// Use browser fetch to bypass Cloudflare
	logger.info(
		{
			domain,
			url,
			referer,
			...streamLog
		},
		'Cloudflare detected for streaming request, switching to browser fetch'
	);

	try {
		// For streaming URLs with referer, we need to visit the referer first
		// to get Cloudflare clearance, then access the stream URL
		if (referer) {
			logger.debug(
				{
					referer,
					domain,
					url,
					...streamLog
				},
				'Attempting two-step Cloudflare fetch using referer first'
			);

			// Step 1: Visit referer site to get clearance
			const refererResult = await browserFetch(
				{
					url: referer,
					method: 'GET'
				},
				{
					headless: config.headless,
					timeoutSeconds: Math.min(config.timeoutSeconds, 60)
				}
			);

			if (!refererResult.success || !refererResult.cookies || refererResult.cookies.length === 0) {
				logger.warn(
					{
						referer,
						domain,
						success: refererResult.success,
						cookieCount: refererResult.cookies?.length || 0,
						...streamLog
					},
					'Failed to obtain Cloudflare cookies from streaming referer'
				);
			} else {
				logger.info(
					{
						referer,
						domain,
						cookieCount: refererResult.cookies.length,
						...streamLog
					},
					'Obtained Cloudflare cookies from streaming referer'
				);

				// Cache the session immediately
				if (refererResult.userAgent) {
					const cookieString = refererResult.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
					cacheSession(domain, cookieString, refererResult.userAgent);
				}

				// Step 2: Try fetching the stream URL with the cookies
				logger.debug(
					{
						domain,
						url,
						...streamLog
					},
					'Fetching streaming URL with referer cookies'
				);

				const cookieHeader = refererResult.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
				const streamResponse = await fetchWithTimeout(url, {
					...options,
					timeout: 30000,
					headers: {
						...options.headers,
						Cookie: cookieHeader,
						'User-Agent':
							refererResult.userAgent || options.headers?.['User-Agent'] || DEFAULT_USER_AGENT,
						Referer: referer
					}
				});

				if (streamResponse.ok) {
					const streamBody = await streamResponse.text();
					if (streamBody.includes('#EXTM3U')) {
						logger.info(
							{
								domain,
								url,
								...streamLog
							},
							'Streaming URL fetched successfully with referer cookies'
						);
						return new Response(streamBody, {
							status: 200,
							statusText: 'OK',
							headers: {
								'Content-Type': 'application/vnd.apple.mpegurl'
							}
						});
					}
				}

				logger.debug(
					{
						domain,
						url,
						...streamLog
					},
					'Streaming URL remained blocked after referer flow, trying direct browser fetch'
				);
			}
		}

		// Fallback: Direct browser fetch of the stream URL
		const browserResult = await browserFetch(
			{
				url,
				method: 'GET'
			},
			{
				headless: config.headless,
				timeoutSeconds: Math.min(config.timeoutSeconds, 60)
			}
		);

		if (!browserResult.success) {
			logger.error(
				{
					domain,
					url,
					referer,
					error: browserResult.error,
					...streamLog
				},
				'Browser fetch failed while bypassing Cloudflare for streaming request'
			);
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		}

		// Cache the session for future requests
		if (browserResult.cookies && browserResult.cookies.length > 0 && browserResult.userAgent) {
			const cookieString = browserResult.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
			cacheSession(domain, cookieString, browserResult.userAgent);
		}

		logger.info(
			{
				domain,
				url,
				bodyLength: browserResult.body.length,
				responseTimeMs: browserResult.timeMs,
				...streamLog
			},
			'Browser fetch succeeded for Cloudflare-protected streaming request'
		);

		// Return response with browser content
		return new Response(browserResult.body, {
			status: browserResult.status,
			statusText: 'OK',
			headers: {
				'Content-Type': 'application/vnd.apple.mpegurl'
			}
		});
	} catch (error) {
		logger.error(
			{
				domain,
				url,
				referer,
				err: error,
				error: error instanceof Error ? error.message : String(error),
				...streamLog
			},
			'Cloudflare streaming bypass failed with browser fetch error'
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}
}

/**
 * Clear all cached Cloudflare sessions
 */
export function clearCloudflareSessions(): void {
	sessionCache.clear();
	logger.info(streamLog, 'Cleared all cached Cloudflare streaming sessions');
}

/**
 * Get statistics about cached sessions
 */
export function getCloudflareSessionStats(): {
	cachedDomains: number;
	sessions: Array<{ domain: string; ageMs: number }>;
} {
	const now = Date.now();
	const sessions: Array<{ domain: string; ageMs: number }> = [];

	for (const [domain, session] of sessionCache.entries()) {
		sessions.push({
			domain,
			ageMs: now - session.timestamp
		});
	}

	return {
		cachedDomains: sessionCache.size,
		sessions
	};
}

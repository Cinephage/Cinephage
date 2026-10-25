/**
 * Live TV Segment Proxy
 *
 * Proxies HLS segments and sub-playlists for Live TV streams.
 * Handles URL rewriting for nested playlists and passes through segment data.
 *
 * KEY FEATURE: Automatic stream URL refresh when tokens expire.
 * Based on Stalkerhek pattern - validates and refreshes URLs on each request.
 *
 * GET /api/livetv/stream/:lineupId/:path?url=<encoded_url>
 */

import type { RequestHandler } from './$types';
import { getBaseUrlAsync } from '#lib/server/streaming/url.js';
import { resolveAndValidateUrl, fetchWithTimeout } from '#lib/server/http/ssrf-protection.js';
import {
	getStreamUrlCache,
	HLS_STREAM_TIMEOUT_MS
} from '#lib/server/livetv/streaming/StreamUrlCache.js';
import { rewriteHlsPlaylistUrls } from '#lib/server/streaming/utils/hls-rewrite.js';
import { STB_USER_AGENT } from '#lib/server/livetv/stalker/StalkerPortalClient.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvStreamProxy', logDomain: 'livetv' });

// Streaming constants
const LIVETV_SEGMENT_FETCH_TIMEOUT_MS = 15000; // Fail faster for quicker retry/failover
const LIVETV_SEGMENT_MAX_SIZE = 50 * 1024 * 1024; // 50MB
const LIVETV_SEGMENT_CACHE_MAX_AGE = 60; // Segments are immutable once created
const LIVETV_MAX_RETRIES = 3;
const LIVETV_RETRY_BASE_DELAY_MS = 1000;
const LIVETV_MAX_REDIRECTS = 5;
const HLS_SNIFF_MAX_BYTES = 8192;
const MAX_HLS_PLAYLIST_BYTES = 5 * 1024 * 1024;

async function readBoundedText(
	body: ReadableStream<Uint8Array>,
	maxBytes: number
): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let text = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) {
				await reader.cancel();
				throw new Error('HLS playlist exceeds the maximum allowed size');
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

function limitStream(
	body: ReadableStream<Uint8Array>,
	maxBytes: number
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let bytesRead = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) {
				await reader.cancel();
				controller.error(new Error('Segment exceeds the maximum allowed size'));
				return;
			}
			controller.enqueue(value);
		},
		async cancel(reason) {
			await reader.cancel(reason);
		}
	});
}

async function inspectPlaylistResponse(
	response: Response
): Promise<{ isPlaylist: boolean; body: ReadableStream<Uint8Array> | null }> {
	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes('mpegurl') || contentType.includes('m3u8')) {
		return { isPlaylist: true, body: response.body };
	}

	const inconclusive =
		!contentType ||
		contentType === 'application/octet-stream' ||
		contentType.startsWith('text/plain');
	if (!inconclusive || !response.body) {
		return { isPlaylist: false, body: response.body };
	}

	const [probeBody, passthroughBody] = response.body.tee();
	const reader = probeBody.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let prefix = '';
	try {
		while (bytesRead < HLS_SNIFF_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value.subarray(0, HLS_SNIFF_MAX_BYTES - bytesRead);
			bytesRead += chunk.byteLength;
			prefix += decoder.decode(chunk, { stream: bytesRead < HLS_SNIFF_MAX_BYTES });
			if (prefix.includes('#EXTM3U')) break;
		}
	} finally {
		void reader.cancel();
	}

	return { isPlaylist: prefix.includes('#EXTM3U'), body: passthroughBody };
}

/**
 * Fetch with retry logic for transient errors
 * Includes automatic URL refresh on authentication failures (403)
 */
async function fetchWithRetry(
	url: string,
	options: RequestInit,
	lineupId: string,
	maxRetries: number = LIVETV_MAX_RETRIES,
	allowUrlRefresh: boolean = true
): Promise<Response> {
	let lastError: Error | null = null;
	const urlCache = getStreamUrlCache();

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetchWithTimeout(url, options, LIVETV_SEGMENT_FETCH_TIMEOUT_MS);

			// Handle 403 Forbidden - likely expired token
			if (response.status === 403 && allowUrlRefresh && attempt < maxRetries) {
				await response.body?.cancel();
				logger.warn(
					{
						lineupId,
						attempt: attempt + 1
					},
					'[LiveTV Segment] Got 403, refreshing stream URL'
				);

				// Refresh the URL and retry
				const refreshed = await urlCache.refreshStream(lineupId);
				const refreshedSafetyCheck = await resolveAndValidateUrl(refreshed.url);
				if (!refreshedSafetyCheck.safe) {
					const error = new Error(`Refreshed stream URL blocked: ${refreshedSafetyCheck.reason}`);
					Object.assign(error, { status: 403 });
					throw error;
				}
				url = refreshed.url;

				// Update headers with new provider headers if available
				if (refreshed.providerHeaders) {
					options.headers = getStreamHeaders(refreshed.providerHeaders);
				}

				// Retry immediately with new URL
				continue;
			}

			// Only retry on 5xx server errors
			if (response.status >= 500 && attempt < maxRetries) {
				await response.body?.cancel();
				await sleepAbortable(
					LIVETV_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
					options.signal ?? undefined
				);
				continue;
			}

			return response;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Refreshed stream URL blocked:')) {
				throw error;
			}
			if (options.signal?.aborted) throw error;
			lastError = error instanceof Error ? error : new Error(String(error));

			// Don't retry on abort (timeout)
			if (lastError.name === 'AbortError') {
				throw new Error(`Segment fetch timeout`, { cause: error });
			}

			if (attempt < maxRetries) {
				await sleepAbortable(
					LIVETV_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
					options.signal ?? undefined
				);
			}
		}
	}

	throw lastError ?? new Error('Segment fetch failed');
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
			return;
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener('abort', abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', abort, { once: true });
	});
}

/**
 * Get headers for upstream requests, merging provider-specific headers if available
 * Provider headers take priority over defaults (e.g., cookies for Stalker portals)
 */
function getStreamHeaders(providerHeaders?: Record<string, string>): HeadersInit {
	return {
		'User-Agent': STB_USER_AGENT,
		Accept: '*/*',
		'Accept-Encoding': 'identity',
		Connection: 'keep-alive',
		...providerHeaders
	};
}

/**
 * Allowed header names that can be passed through from provider headers.
 * This prevents injection of security-sensitive headers like Host, Authorization, etc.
 */
const ALLOWED_PROVIDER_HEADERS = new Set([
	'cookie',
	'user-agent',
	'referer',
	'accept',
	'accept-language',
	'accept-encoding',
	'x-forwarded-for',
	'x-real-ip'
]);

/**
 * Decode provider headers from base64-encoded query parameter.
 * Returns undefined if not present or invalid.
 * Filters to only allowed header names to prevent header injection.
 */
function decodeProviderHeaders(encoded: string | null): Record<string, string> | undefined {
	if (!encoded) return undefined;
	try {
		const json = atob(encoded);
		const headers = JSON.parse(json);
		if (typeof headers === 'object' && headers !== null && !Array.isArray(headers)) {
			// Filter to allowed headers only
			const filtered: Record<string, string> = {};
			for (const [key, value] of Object.entries(headers)) {
				if (
					ALLOWED_PROVIDER_HEADERS.has(key.toLowerCase()) &&
					typeof value === 'string' &&
					!value.includes('\r') &&
					!value.includes('\n')
				) {
					filtered[key] = value;
				}
			}
			return Object.keys(filtered).length > 0 ? filtered : undefined;
		}
	} catch {
		// Invalid base64 or JSON - ignore silently
	}
	return undefined;
}

/**
 * Encode provider headers as a base64 string for embedding in URLs.
 * Returns undefined if no headers to encode.
 */
function encodeProviderHeaders(headers?: Record<string, string>): string | undefined {
	if (!headers || Object.keys(headers).length === 0) return undefined;
	return btoa(JSON.stringify(headers));
}

/**
 * Build a LiveTV segment proxy URL builder for the shared HLS rewriter.
 */
function makeLiveTvProxyUrlBuilder(
	baseUrl: string,
	lineupId: string,
	encodedHeaders?: string
): (absoluteUrl: string, isSegment: boolean) => string {
	return (absoluteUrl: string, isSegment: boolean): string => {
		const extension = isSegment ? 'ts' : 'm3u8';
		let proxyUrl = `${baseUrl}/api/livetv/stream/${lineupId}/segment.${extension}?url=${encodeURIComponent(absoluteUrl)}`;
		if (encodedHeaders) {
			proxyUrl += `&h=${encodeURIComponent(encodedHeaders)}`;
		}
		return proxyUrl;
	};
}

/**
 * Validate and potentially refresh stream URL before use
 * Based on Stalkerhek pattern - checks URL age and refreshes if stale
 */
async function validateAndRefreshUrl(
	lineupId: string,
	originalUrl: string,
	providerHeaders?: Record<string, string>
): Promise<{ url: string; headers: Record<string, string> }> {
	const urlCache = getStreamUrlCache();
	const cached = urlCache.getCached(lineupId);

	// Check if we have a cached entry and if the URL matches
	if (cached && cached.url === originalUrl) {
		// Check if still valid
		if (urlCache.isValid(cached)) {
			logger.debug(
				{
					lineupId,
					age: Date.now() - cached.createdAt
				},
				'[LiveTV Segment] Using valid cached URL'
			);
			return { url: originalUrl, headers: providerHeaders || {} };
		}

		// URL is stale - refresh it
		logger.info(
			{
				lineupId,
				age: Date.now() - cached.createdAt,
				maxAge: cached.type === 'hls' ? HLS_STREAM_TIMEOUT_MS : 5000
			},
			'[LiveTV Segment] Stream URL expired, refreshing'
		);

		const refreshed = await urlCache.refreshStream(lineupId);
		return {
			url: refreshed.url,
			headers: refreshed.providerHeaders || {}
		};
	}

	// No cached entry or URL doesn't match cache - just use provided URL
	return { url: originalUrl, headers: providerHeaders || {} };
}

export const GET: RequestHandler = async ({ params, url, request }) => {
	const { lineupId } = params;

	// Get segment URL from query parameter
	const segmentUrl = url.searchParams.get('url');
	if (!segmentUrl) {
		return new Response(JSON.stringify({ error: 'Missing segment URL' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Note: url.searchParams.get() already returns decoded value
	// Do NOT call decodeURIComponent again - it would double-decode and corrupt URLs
	let decodedUrl = segmentUrl;

	// Decode provider-specific headers from query param (forwarded from main proxy)
	const encodedHeaders = url.searchParams.get('h');
	let providerHeaders = decodeProviderHeaders(encodedHeaders);

	// Validate and refresh URL if needed (Stalkerhek pattern)
	try {
		const validated = await validateAndRefreshUrl(lineupId, decodedUrl, providerHeaders);
		decodedUrl = validated.url;
		providerHeaders = validated.headers;
	} catch (error) {
		logger.error(
			{ err: error, ...{ lineupId } },
			'[LiveTV Segment] Failed to validate/refresh stream URL'
		);
		return new Response(JSON.stringify({ error: 'Failed to refresh stream URL' }), {
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// SSRF protection (with DNS resolution)
	const safetyCheck = await resolveAndValidateUrl(decodedUrl);
	if (!safetyCheck.safe) {
		logger.warn(
			{
				lineupId,
				reason: safetyCheck.reason
			},
			'[LiveTV Segment] Blocked unsafe URL'
		);
		return new Response(JSON.stringify({ error: 'URL blocked', reason: safetyCheck.reason }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	try {
		// Follow redirects manually to validate each redirect target for SSRF
		let currentUrl = decodedUrl;
		let redirectCount = 0;
		const visitedUrls = new Set<string>();
		let response: Response;

		while (true) {
			if (visitedUrls.has(currentUrl)) {
				logger.warn({ lineupId, url: currentUrl }, '[LiveTV Segment] Redirect loop detected');
				return new Response(JSON.stringify({ error: 'Redirect loop detected' }), {
					status: 508,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			visitedUrls.add(currentUrl);

			if (redirectCount >= LIVETV_MAX_REDIRECTS) {
				logger.warn({ lineupId }, '[LiveTV Segment] Max redirects exceeded');
				return new Response(JSON.stringify({ error: 'Too many redirects' }), {
					status: 508,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			response = await fetchWithRetry(
				currentUrl,
				{
					headers: getStreamHeaders(providerHeaders),
					redirect: 'manual',
					signal: request.signal
				},
				lineupId
			);

			// Handle redirects with SSRF validation
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				if (location) {
					await response.body?.cancel();
					const redirectUrl = new URL(location, currentUrl).toString();
					const redirectSafetyCheck = await resolveAndValidateUrl(redirectUrl);
					if (!redirectSafetyCheck.safe) {
						logger.warn(
							{
								lineupId,
								url: redirectUrl,
								reason: redirectSafetyCheck.reason
							},
							'[LiveTV Segment] Blocked unsafe redirect'
						);
						return new Response(
							JSON.stringify({
								error: 'Redirect target not allowed',
								reason: redirectSafetyCheck.reason
							}),
							{ status: 403, headers: { 'Content-Type': 'application/json' } }
						);
					}
					currentUrl = redirectUrl;
					redirectCount++;
					continue;
				}
			}

			// Not a redirect, break out of loop
			break;
		}

		if (!response.ok) {
			await response.body?.cancel();
			return new Response(JSON.stringify({ error: `Segment fetch failed: ${response.status}` }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Check content length before reading
		const contentLength = response.headers.get('content-length');
		if (contentLength) {
			const size = parseInt(contentLength, 10);
			if (size > LIVETV_SEGMENT_MAX_SIZE) {
				await response.body?.cancel();
				logger.warn(
					{
						lineupId,
						size,
						maxSize: LIVETV_SEGMENT_MAX_SIZE
					},
					'[LiveTV Segment] Segment too large'
				);
				return new Response(JSON.stringify({ error: 'Segment too large' }), {
					status: 413,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		const contentType = response.headers.get('content-type') || '';
		const inspected = await inspectPlaylistResponse(response);

		// Check if this is a nested playlist that needs rewriting
		if (inspected.isPlaylist && inspected.body) {
			const playlist = await readBoundedText(inspected.body, MAX_HLS_PLAYLIST_BYTES);

			if (playlist.includes('#EXTM3U')) {
				const baseUrl = await getBaseUrlAsync(request);
				// Pass through provider headers so nested sub-playlists/segments also get them
				const rewritten = rewriteHlsPlaylistUrls(
					playlist,
					decodedUrl,
					makeLiveTvProxyUrlBuilder(baseUrl, lineupId, encodeProviderHeaders(providerHeaders))
				);

				return new Response(rewritten, {
					status: 200,
					headers: {
						'Content-Type': 'application/vnd.apple.mpegurl',
						'Accept-Ranges': 'none',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
						'Access-Control-Allow-Headers': 'Range, Content-Type',
						'Cache-Control': 'no-cache',
						'X-Content-Type-Options': 'nosniff'
					}
				});
			}
		}

		if (!inspected.body) {
			return new Response(null, { status: 204 });
		}

		return new Response(limitStream(inspected.body, LIVETV_SEGMENT_MAX_SIZE), {
			status: 200,
			headers: {
				'Content-Type':
					contentType && contentType !== 'application/octet-stream' ? contentType : 'video/mp2t',
				'Accept-Ranges': 'none',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
				'Access-Control-Allow-Headers': 'Range, Content-Type',
				'Cache-Control': `public, max-age=${LIVETV_SEGMENT_CACHE_MAX_AGE}`,
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (error) {
		logger.error(
			{
				err: error,
				...{
					lineupId,
					url: decodedUrl.substring(0, 100)
				}
			},
			'[LiveTV Segment] Segment proxy failed'
		);
		return new Response(
			JSON.stringify({ error: error instanceof Error ? error.message : 'Segment proxy error' }),
			{
				status:
					error instanceof Error && 'status' in error && typeof error.status === 'number'
						? error.status
						: 502,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}
};

export const HEAD: RequestHandler = async ({ params, url, request }) => {
	const segmentUrl = url.searchParams.get('url');

	if (!segmentUrl) {
		return new Response(null, { status: 400 });
	}

	const lineupId = params.lineupId;
	const safetyCheck = await resolveAndValidateUrl(segmentUrl);
	if (!safetyCheck.safe) {
		return new Response(JSON.stringify({ error: 'URL blocked', reason: safetyCheck.reason }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	try {
		let currentUrl = segmentUrl;
		let redirectCount = 0;
		const visitedUrls = new Set<string>();
		let response: Response;
		while (true) {
			if (visitedUrls.has(currentUrl) || redirectCount >= LIVETV_MAX_REDIRECTS) {
				return new Response(JSON.stringify({ error: 'Too many redirects' }), {
					status: 508,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			visitedUrls.add(currentUrl);
			response = await fetchWithRetry(
				currentUrl,
				{
					method: 'HEAD',
					headers: getStreamHeaders(),
					redirect: 'manual',
					signal: request?.signal
				},
				lineupId,
				0,
				false
			);
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get('location');
			if (!location) break;
			await response.body?.cancel();
			const redirectUrl = new URL(location, currentUrl).toString();
			const redirectSafetyCheck = await resolveAndValidateUrl(redirectUrl);
			if (!redirectSafetyCheck.safe) {
				return new Response(
					JSON.stringify({
						error: 'Redirect target not allowed',
						reason: redirectSafetyCheck.reason
					}),
					{ status: 403, headers: { 'Content-Type': 'application/json' } }
				);
			}
			currentUrl = redirectUrl;
			redirectCount++;
		}
		await response.body?.cancel();

		if (!response.ok) {
			return new Response(JSON.stringify({ error: `Segment fetch failed: ${response.status}` }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const contentType = response.headers.get('content-type') || 'video/mp2t';
		const isPlaylist = contentType.includes('mpegurl') || contentType.includes('m3u8');
		const headers = new Headers({
			'Content-Type': contentType,
			'Accept-Ranges': 'none',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Range, Content-Type',
			'Cache-Control': isPlaylist ? 'no-cache' : `public, max-age=${LIVETV_SEGMENT_CACHE_MAX_AGE}`,
			'X-Content-Type-Options': 'nosniff'
		});
		const contentLength = response.headers.get('content-length');
		if (contentLength) headers.set('Content-Length', contentLength);

		return new Response(null, { status: 200, headers });
	} catch (error) {
		return new Response(
			JSON.stringify({ error: error instanceof Error ? error.message : 'Segment HEAD failed' }),
			{ status: 502, headers: { 'Content-Type': 'application/json' } }
		);
	}
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 200,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Range, Content-Type'
		}
	});
};

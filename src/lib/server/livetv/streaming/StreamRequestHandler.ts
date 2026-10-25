/**
 * Live TV Stream Request Handler
 *
 * Extracted shared logic for handling LiveTV stream requests.
 * This module contains the core streaming logic independent of SvelteKit route types,
 * allowing it to be used by multiple route handlers ([lineupId] and [lineupId].ts).
 *
 * STREAMING MODES:
 *
 * 1. Default (no format param) — Server-side HLS-to-TS conversion
 *    This is the primary mode, used by media servers (Jellyfin/Plex/Emby) when
 *    they tune to a channel from the M3U playlist. Media servers' M3U tuners
 *    expect a continuous MPEG-TS byte stream — they cannot consume HLS playlists.
 *    The HlsToTsConverter fetches HLS playlists from the portal (getting a fresh
 *    play_token via createLink each cycle), downloads segments in sequence order,
 *    and pipes them as one continuous TS stream.
 *
 * 2. HLS mode (format=hls) — Returns the raw HLS playlist with rewritten URLs
 *    Segment URLs are rewritten to go through the segment proxy.
 *    Used by HLS-aware clients that can handle playlist refreshes themselves.
 *
 * 3. Direct TS mode (format=ts) — Resolve URL, fetch, pipe body directly
 *    No reconnection logic. When upstream closes (~24s on stalker), response ends.
 *
 * ENDPOINTS:
 *    GET  /api/livetv/stream/:lineupId              (HLS-to-TS conversion)
 *    GET  /api/livetv/stream/:lineupId?format=hls   (HLS playlist passthrough)
 *    GET  /api/livetv/stream/:lineupId?format=ts    (direct TS pipe)
 *    HEAD /api/livetv/stream/:lineupId               (content-type probe)
 */

import { getStreamUrlCache } from './StreamUrlCache.js';
import { getLiveTvStreamService } from './LiveTvStreamService.js';
import { createHlsToTsStream } from './HlsToTsConverter.js';
import { getBaseUrlAsync } from '#lib/server/streaming/url.js';
import { rewriteHlsPlaylistUrls } from '#lib/server/streaming/utils/hls-rewrite.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'livetv' as const });

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
 * Standard CORS + cache headers for HLS playlist responses
 */
const HLS_RESPONSE_HEADERS = {
	'Content-Type': 'application/vnd.apple.mpegurl',
	'Accept-Ranges': 'none',
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Range, Content-Type',
	'Cache-Control': 'public, max-age=2, stale-while-revalidate=5',
	'X-Content-Type-Options': 'nosniff'
} as const;

/**
 * Standard headers for direct TS stream responses
 */
const DIRECT_TS_RESPONSE_HEADERS = {
	'Content-Type': 'video/mp2t',
	'Transfer-Encoding': 'chunked',
	'Accept-Ranges': 'none',
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Range, Content-Type',
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff'
} as const;

const HLS_PROBE_MAX_BYTES = 8192;
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

function hasHlsContentType(response: Response): boolean {
	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	return contentType.includes('mpegurl') || contentType.includes('m3u8');
}

async function inspectHlsResponse(
	response: Response,
	closeHlsBody = true
): Promise<{ isHls: boolean; body: ReadableStream<Uint8Array> | null }> {
	if (hasHlsContentType(response)) {
		if (closeHlsBody) await response.body?.cancel();
		return { isHls: true, body: response.body };
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (
		contentType &&
		contentType !== 'application/octet-stream' &&
		!contentType.startsWith('text/plain')
	) {
		return { isHls: false, body: response.body };
	}

	if (!response.body) {
		return { isHls: false, body: null };
	}

	const [probeBody, passthroughBody] = response.body.tee();
	const reader = probeBody.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let prefix = '';

	try {
		while (bytesRead < HLS_PROBE_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;

			const remaining = HLS_PROBE_MAX_BYTES - bytesRead;
			const chunk = value.subarray(0, remaining);
			bytesRead += chunk.byteLength;
			prefix += decoder.decode(chunk, { stream: bytesRead < HLS_PROBE_MAX_BYTES });
			if (prefix.includes('#EXTM3U')) break;
		}
	} finally {
		if (prefix.includes('#EXTM3U')) {
			if (closeHlsBody) {
				await Promise.all([reader.cancel(), passthroughBody.cancel()]);
			} else {
				void reader.cancel();
			}
		} else {
			void reader.cancel();
		}
	}

	if (prefix.includes('#EXTM3U')) {
		return { isHls: true, body: closeHlsBody ? null : passthroughBody };
	}

	return { isHls: false, body: passthroughBody };
}

/**
 * Handle GET requests for LiveTV streams.
 *
 * @param lineupId - The lineup item ID
 * @param request - The incoming request (for base URL detection)
 * @param url - The request URL (for query params like format)
 * @returns Response with the stream
 */
export async function handleStreamGet(
	lineupId: string,
	request: Request,
	url: URL
): Promise<Response> {
	// Check for explicit format preference
	const formatParam = url.searchParams.get('format');

	try {
		const streamService = getLiveTvStreamService();
		const urlCache = getStreamUrlCache();

		// =====================================================================
		// EXPLICIT HLS MODE (format=hls): Return HLS playlist with rewritten URLs
		// =====================================================================
		if (formatParam === 'hls') {
			const resolved = await urlCache.getStream(lineupId, 'hls');

			logger.debug(
				{
					lineupId,
					type: resolved.type,
					url: resolved.url.substring(0, 50)
				},
				'[LiveTV Stream] HLS playlist mode'
			);

			{
				const baseUrl = await getBaseUrlAsync(request);

				// Invalidate cache BEFORE fetching — the token is consumed by the fetch
				urlCache.invalidate(lineupId);

				const { response, finalUrl } = await streamService.fetchFromUrl(
					resolved.url,
					resolved.providerType,
					resolved.providerHeaders,
					request.signal
				);

				if (!response.ok) {
					await response.body?.cancel();
					// Retry once with a completely fresh URL
					logger.warn(
						{
							lineupId,
							status: response.status
						},
						'[LiveTV Stream] Playlist fetch failed, refreshing URL'
					);
					const refreshed = await urlCache.getStream(lineupId);
					urlCache.invalidate(lineupId);

					const { response: retryResponse, finalUrl: retryFinalUrl } =
						await streamService.fetchFromUrl(
							refreshed.url,
							refreshed.providerType,
							refreshed.providerHeaders,
							request.signal
						);

					if (!retryResponse.ok) {
						await retryResponse.body?.cancel();
						throw new Error(`Failed to fetch playlist: ${retryResponse.status}`);
					}

					const inspectedRetry = await inspectHlsResponse(retryResponse, false);
					if (!inspectedRetry.isHls || !inspectedRetry.body) {
						await inspectedRetry.body?.cancel();
						throw new Error('Invalid HLS playlist received');
					}
					const playlist = await readBoundedText(inspectedRetry.body, MAX_HLS_PLAYLIST_BYTES);
					if (!playlist.includes('#EXTM3U')) {
						throw new Error('Invalid HLS playlist received');
					}

					const encodedHeaders = encodeProviderHeaders(refreshed.providerHeaders);
					const rewritten = rewriteHlsPlaylistUrls(
						playlist,
						retryFinalUrl,
						makeLiveTvProxyUrlBuilder(baseUrl, lineupId, encodedHeaders)
					);

					return new Response(rewritten, { status: 200, headers: HLS_RESPONSE_HEADERS });
				}

				const inspected = await inspectHlsResponse(response, false);
				if (!inspected.isHls) {
					if (!inspected.body) throw new Error('Stream has no body');
					return new Response(inspected.body, {
						status: 200,
						headers: DIRECT_TS_RESPONSE_HEADERS
					});
				}

				if (!inspected.body) throw new Error('HLS response has no body');
				const playlist = await readBoundedText(inspected.body, MAX_HLS_PLAYLIST_BYTES);

				if (!playlist.includes('#EXTM3U')) {
					logger.warn(
						{
							lineupId
						},
						'[LiveTV Stream] Expected HLS but got non-playlist content'
					);
					return new Response(playlist, {
						status: 200,
						headers: {
							'Content-Type': response.headers.get('content-type') || 'video/mp2t',
							'Access-Control-Allow-Origin': '*',
							'Cache-Control': 'no-store'
						}
					});
				}

				const rewritten = rewriteHlsPlaylistUrls(
					playlist,
					finalUrl,
					makeLiveTvProxyUrlBuilder(
						baseUrl,
						lineupId,
						encodeProviderHeaders(resolved.providerHeaders)
					)
				);

				return new Response(rewritten, { status: 200, headers: HLS_RESPONSE_HEADERS });
			}
		}

		// =====================================================================
		// EXPLICIT TS MODE (format=ts): Direct TS pipe
		// =====================================================================
		if (formatParam === 'ts') {
			const resolved = await urlCache.getStream(lineupId, 'ts');

			logger.info(
				{
					lineupId,
					url: resolved.url.substring(0, 60)
				},
				'[LiveTV Stream] Direct TS pipe'
			);

			const { response } = await streamService.fetchFromUrl(
				resolved.url,
				resolved.providerType,
				resolved.providerHeaders,
				request.signal
			);

			if (!response.body) {
				throw new Error('Stream has no body');
			}

			return new Response(response.body, {
				status: 200,
				headers: DIRECT_TS_RESPONSE_HEADERS
			});
		}

		// =====================================================================
		// DEFAULT MODE: Server-side HLS-to-TS conversion
		// =====================================================================
		{
			// Probe the stream type first to determine if HLS-to-TS is appropriate
			const resolved = await urlCache.getStream(lineupId, 'hls');

			logger.info(
				{
					lineupId,
					type: resolved.type,
					providerType: resolved.providerType,
					url: resolved.url.substring(0, 50)
				},
				'[LiveTV Stream] HLS-to-TS conversion mode'
			);

			const { response, finalUrl } = await streamService.fetchFromUrl(
				resolved.url,
				resolved.providerType,
				resolved.providerHeaders,
				request.signal
			);

			const inspected = await inspectHlsResponse(response, false);
			if (inspected.isHls) {
				if (!inspected.body) throw new Error('HLS response has no body');

				// Create the HLS-to-TS conversion stream
				const tsStream = createHlsToTsStream({
					lineupItemId: lineupId,
					signal: request.signal,
					initialPlaylist: {
						body: inspected.body,
						finalUrl,
						providerHeaders: resolved.providerHeaders
					}
				});

				return new Response(tsStream, {
					status: 200,
					headers: DIRECT_TS_RESPONSE_HEADERS
				});
			}

			// Non-HLS stream (e.g., M3U provider with direct TS URL) — pipe directly
			logger.info(
				{
					lineupId,
					type: resolved.type,
					url: resolved.url.substring(0, 60)
				},
				'[LiveTV Stream] Non-HLS stream, direct pipe'
			);

			if (!inspected.body) {
				throw new Error('Stream has no body');
			}

			return new Response(inspected.body, {
				status: 200,
				headers: DIRECT_TS_RESPONSE_HEADERS
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Stream failed';
		logger.error({ err: error, ...{ lineupId } }, '[LiveTV Stream] Stream failed');

		// Determine appropriate status code
		let status = 502;
		if (message.includes('not found')) {
			status = 404;
		} else if (message.includes('disabled')) {
			status = 403;
		}

		return new Response(JSON.stringify({ error: message }), {
			status,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

/**
 * Handle HEAD requests for LiveTV streams.
 *
 * @param lineupId - The lineup item ID
 * @param url - The request URL (for query params like format)
 * @returns Response with appropriate headers
 */
export async function handleStreamHead(
	lineupId: string,
	url: URL,
	signal?: AbortSignal
): Promise<Response> {
	try {
		const formatParam = url.searchParams.get('format');
		const format = formatParam === 'ts' ? 'ts' : 'hls';
		const resolved = await getStreamUrlCache().getStream(lineupId, format);
		const streamService = getLiveTvStreamService();
		const { response } = await streamService.fetchFromUrl(
			resolved.url,
			resolved.providerType,
			resolved.providerHeaders,
			signal
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Upstream stream validation failed: ${response.status}`);
		}
		await response.body?.cancel();

		return new Response(null, {
			status: 200,
			headers: {
				'Content-Type': response.headers.get('content-type') || 'video/mp2t',
				'Accept-Ranges': 'none',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
				'Access-Control-Allow-Headers': 'Range, Content-Type',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Stream validation failed';
		return new Response(JSON.stringify({ error: message }), {
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

/**
 * Handle OPTIONS requests for CORS preflight.
 *
 * @returns Response with CORS headers
 */
export function handleStreamOptions(): Response {
	return new Response(null, {
		status: 200,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Range, Content-Type'
		}
	});
}

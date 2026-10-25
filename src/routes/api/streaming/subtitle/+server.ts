/**
 * Subtitle Proxy Endpoint
 *
 * Proxies VTT/SRT subtitle files with proper referer headers.
 * Required because:
 * - Subtitle URLs may require referer headers
 * - CORS restrictions prevent direct client access
 * - Auto-converts SRT to VTT format for HLS compatibility
 *
 * GET /api/streaming/subtitle?url=<encoded_url>&referer=<encoded_referer>
 */

import type { RequestHandler } from './$types';
import { logger } from '#lib/logging/index.js';
import { ensureVttFormat } from '#lib/server/streaming/utils/index.js';
import {
	resolveAndValidateUrl,
	fetchWithTimeout,
	MAX_REDIRECTS
} from '#lib/server/http/ssrf-protection.js';

const streamLog = { logDomain: 'streams' as const };

// Maximum subtitle file size (2MB should be plenty for any subtitle file)
const MAX_SUBTITLE_SIZE = 2 * 1024 * 1024;

export const GET: RequestHandler = async ({ url }) => {
	const subtitleUrl = url.searchParams.get('url');
	const referer = url.searchParams.get('referer') || '';

	if (!subtitleUrl) {
		return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Note: url.searchParams.get() already returns decoded value
	// Do NOT call decodeURIComponent again - it would double-decode and corrupt URLs
	const decodedUrl = subtitleUrl;

	try {
		// SSRF protection (with DNS resolution)
		const safetyCheck = await resolveAndValidateUrl(decodedUrl);
		if (!safetyCheck.safe) {
			logger.warn(
				{
					url: decodedUrl,
					reason: safetyCheck.reason,
					...streamLog
				},
				'Blocked unsafe subtitle URL'
			);
			return new Response(
				JSON.stringify({ error: 'URL not allowed', reason: safetyCheck.reason }),
				{ status: 403, headers: { 'Content-Type': 'application/json' } }
			);
		}

		const headers: HeadersInit = {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
			Accept: 'text/vtt, text/plain, */*'
		};

		if (referer) {
			headers['Referer'] = referer;
		}

		// Follow redirects with loop protection
		let currentUrl = decodedUrl;
		let redirectCount = 0;
		const visitedUrls = new Set<string>();
		let response: Response;

		while (true) {
			if (visitedUrls.has(currentUrl)) {
				return new Response(JSON.stringify({ error: 'Redirect loop detected' }), {
					status: 508,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			visitedUrls.add(currentUrl);

			if (redirectCount >= MAX_REDIRECTS) {
				return new Response(JSON.stringify({ error: 'Too many redirects' }), {
					status: 508,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			response = await fetchWithTimeout(currentUrl, {
				headers,
				redirect: 'manual'
			});

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				if (location) {
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
					continue;
				}
			}

			break;
		}

		if (!response.ok) {
			logger.warn(
				{
					url: decodedUrl.substring(0, 100),
					status: response.status,
					...streamLog
				},
				'Subtitle fetch failed'
			);
			return new Response(JSON.stringify({ error: `Upstream error: ${response.status}` }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Check content length
		const contentLength = response.headers.get('content-length');
		if (contentLength) {
			const size = parseInt(contentLength, 10);
			if (size > MAX_SUBTITLE_SIZE) {
				return new Response(
					JSON.stringify({
						error: 'Subtitle file too large',
						size,
						maxSize: MAX_SUBTITLE_SIZE
					}),
					{ status: 413, headers: { 'Content-Type': 'application/json' } }
				);
			}
		}

		const rawContent = await response.text();

		// Convert to VTT when possible. ASS/SSA and unknown binaries are not
		// silently relabeled as text/vtt — reject them instead of serving garbage.
		const content = ensureVttFormat(rawContent);
		if (content === null) {
			return new Response(
				JSON.stringify({ error: 'Subtitle format is not convertible to WebVTT' }),
				{
					status: 415,
					headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
				}
			);
		}

		logger.debug(
			{
				url: decodedUrl.substring(0, 100),
				originalSize: contentLength,
				finalSize: content.length,
				...streamLog
			},
			'Subtitle proxied successfully'
		);

		return new Response(content, {
			status: 200,
			headers: {
				'Content-Type': 'text/vtt; charset=utf-8',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Cache-Control': 'public, max-age=3600'
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (message.includes('abort')) {
			return new Response(JSON.stringify({ error: 'Subtitle fetch timeout' }), {
				status: 504,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		logger.error({ err: error, ...{ url: decodedUrl, ...streamLog } }, 'Subtitle proxy error');
		return new Response(JSON.stringify({ error: 'Subtitle proxy error', details: message }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 200,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type'
		}
	});
};

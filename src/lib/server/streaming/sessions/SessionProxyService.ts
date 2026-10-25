import { logger } from '#lib/logging/index.js';
import {
	resolveAndValidateUrl,
	fetchWithTimeout,
	MAX_REDIRECTS
} from '#lib/server/http/ssrf-protection.js';
import { isHLSPlaylist, sanitizePlaylist, validatePlaylist } from '../hls';
import { ensureVttFormat } from '../utils/srt-to-vtt';
import { isPngWrappedSegment, stripPngWrapper } from '../utils/png-wrapper';
import type { PlaybackSession } from '../types';
import { getPlaybackSessionStore } from './session-store';
import { rewriteSessionPlaylist } from './playlist-rewriter';
import { rewriteDashManifest } from './dash-rewriter';
import { appendBasePath } from '../url.js';

const streamLog = { logDomain: 'streams' as const };
const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_TEXT_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

function isRangeHeaderName(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower === 'range' ||
		lower === 'if-range' ||
		lower === 'if-none-match' ||
		lower === 'if-modified-since'
	);
}

function buildUpstreamHeaders(session: PlaybackSession, request?: Request): Record<string, string> {
	const headers: Record<string, string> = {
		...session.requestHeaders,
		'User-Agent':
			session.requestHeaders['User-Agent'] ||
			session.requestHeaders['user-agent'] ||
			DEFAULT_USER_AGENT,
		Accept: session.requestHeaders.Accept || session.requestHeaders.accept || '*/*',
		'Accept-Encoding': 'identity'
	};

	if (!headers.Referer && !headers.referer && session.requestHeaders.referer) {
		headers.Referer = session.requestHeaders.referer;
	}

	// Origin is a browser-enforced CORS request header. Forwarding it to media
	// origins triggers hotlink/anti-leech rules on some CDNs (observed: a
	// subtitle segment returns 404 only when Origin is present) and is not
	// needed for server-side media fetches.
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === 'origin') {
			delete headers[name];
		}
	}

	if (request) {
		for (const [name, value] of request.headers.entries()) {
			if (!isRangeHeaderName(name)) {
				continue;
			}

			headers[name] = value;
		}
	}

	return headers;
}

function buildStreamingResponseHeaders(
	response: Response,
	fallbackContentType: string,
	options: { overrideContentType?: boolean; bodyLengthChanged?: boolean } = {}
): Headers {
	const headers = new Headers();

	for (const [name, value] of response.headers.entries()) {
		if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
			continue;
		}
		headers.set(name, value);
	}

	if (!headers.has('Content-Type') || options.overrideContentType) {
		headers.set('Content-Type', fallbackContentType);
	}
	if (options.overrideContentType) {
		headers.delete('content-disposition');
		headers.delete('x-content-type-options');
	}

	if (options.bodyLengthChanged) {
		headers.delete('content-length');
	}

	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
	headers.set(
		'Access-Control-Allow-Headers',
		'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type'
	);
	headers.set(
		'Access-Control-Expose-Headers',
		'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified'
	);
	return headers;
}

function detectBinaryContentType(url: string, contentType: string | null): string {
	if (contentType) {
		return contentType;
	}

	const normalized = url.toLowerCase();
	if (normalized.includes('.mp4') || normalized.includes('.m4s')) {
		return 'video/mp4';
	}
	if (normalized.includes('.jpg') || normalized.includes('.jpeg')) {
		return 'image/jpeg';
	}
	return 'application/octet-stream';
}

function isSuspiciousDirectContentType(contentType: string | null): boolean {
	if (!contentType) return true;
	const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
	return normalized.startsWith('image/') || normalized === 'application/octet-stream';
}

function sniffVideoContentType(bytes: Uint8Array): string | null {
	if (bytes.length >= 12) {
		const ascii = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 512)));
		if (ascii.slice(4, 8) === 'ftyp') {
			return ascii.slice(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
		}
		if (ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'AVI ') return 'video/x-msvideo';
		if (ascii.slice(0, 4) === 'OggS') return 'video/ogg';
		if (ascii.slice(0, 3) === 'FLV') return 'video/x-flv';
	}
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3
	) {
		const header = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 512)));
		return header.toLowerCase().includes('webm') ? 'video/webm' : 'video/x-matroska';
	}
	if (bytes.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47) return 'video/mp2t';
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x00 &&
		bytes[1] === 0x00 &&
		bytes[2] === 0x01 &&
		(bytes[3] === 0xba || bytes[3] === 0xb3)
	) {
		return 'video/mpeg';
	}
	return null;
}

async function peekStream(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<{
	prefix: Uint8Array<ArrayBuffer>;
	body: ReadableStream<Uint8Array<ArrayBuffer>>;
}> {
	const reader = body.getReader();
	const initialChunks: Uint8Array<ArrayBuffer>[] = [];
	let prefixLength = 0;
	while (prefixLength < 512) {
		const next = await reader.read();
		if (next.done || !next.value) break;
		initialChunks.push(next.value);
		prefixLength += next.value.byteLength;
	}
	if (initialChunks.length === 0) {
		return { prefix: new Uint8Array(), body: new ReadableStream({ start: (c) => c.close() }) };
	}

	const prefix = new Uint8Array(prefixLength);
	let offset = 0;
	for (const chunk of initialChunks) {
		prefix.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let pendingChunk = 0;
	return {
		prefix,
		body: new ReadableStream<Uint8Array<ArrayBuffer>>({
			async pull(controller) {
				if (pendingChunk < initialChunks.length) {
					controller.enqueue(initialChunks[pendingChunk++]);
					return;
				}
				const next = await reader.read();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			}
		})
	};
}

function responseMayHaveBody(status: number): boolean {
	return status !== 204 && status !== 205 && status !== 304;
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) {
		return '';
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalSize = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			totalSize += value.byteLength;
			if (totalSize > maxBytes) {
				await reader.cancel();
				throw new Error(`Response exceeded ${maxBytes} bytes`);
			}

			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function fetchUpstream(
	url: string,
	headers: Record<string, string>,
	method: 'GET' | 'HEAD' = 'GET'
): Promise<Response> {
	let currentUrl = url;
	let redirectCount = 0;
	const visitedUrls = new Set<string>();

	while (true) {
		if (visitedUrls.has(currentUrl)) {
			throw new Error('Redirect loop detected');
		}
		visitedUrls.add(currentUrl);

		const safetyCheck = await resolveAndValidateUrl(currentUrl);
		if (!safetyCheck.safe) {
			throw new Error(safetyCheck.reason || 'URL not allowed');
		}

		const response = await fetchWithTimeout(
			currentUrl,
			{
				headers,
				method,
				redirect: 'manual'
			},
			30_000
		);

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) {
				return response;
			}
			await response.body?.cancel();

			if (redirectCount >= MAX_REDIRECTS) {
				throw new Error('Too many redirects');
			}

			currentUrl = new URL(location, currentUrl).toString();
			redirectCount += 1;
			continue;
		}

		return response;
	}
}

export class SessionProxyService {
	private readonly store = getPlaybackSessionStore();

	/**
	 * Serve a session launch for .strm consumers (media servers) at a path
	 * without a `.m3u` suffix. Jellyfin refuses to remux any HTTP source whose
	 * path contains `.m3u` (MediaSourceManager.SupportsDirectStream), so the
	 * entry URL must be extension-less or progressive.
	 *
	 * Source-aware: HLS and DASH stay manifests (rewritten only for authenticated
	 * proxy URLs), while MP4 and other direct containers keep their original
	 * byte stream, Range semantics, and media type.
	 */
	async renderLaunchMedia(
		session: PlaybackSession,
		baseUrl: string,
		apiKey: string | undefined,
		request: Request
	): Promise<Response> {
		if (session.sourceType === 'dash') {
			return this.renderDashManifestResponse(session, baseUrl, apiKey);
		}

		if (session.sourceType === 'mp4' || session.sourceType === 'file') {
			return this.renderDirectResponse(session, request);
		}

		return this.renderPlaylistResponse(session, session.entryUrl, baseUrl, apiKey, true);
	}

	/**
	 * Serve a DASH source's MPD, rewritten through the session so segments are
	 * fetched via our proxy (which attaches the signed session headers, e.g.
	 * CloudFront cookies). Served as application/dash+xml — the content type
	 * identifies the manifest, no .m3u path involved.
	 */
	private async renderDashManifestResponse(
		session: PlaybackSession,
		baseUrl: string,
		apiKey: string | undefined
	): Promise<Response> {
		const response = await fetchUpstream(session.entryUrl, buildUpstreamHeaders(session));
		if (!response.ok) {
			return new Response(JSON.stringify({ error: `Upstream error: ${response.status}` }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const mpd = await readBodyWithLimit(response, MAX_TEXT_RESPONSE_BYTES);
		const rewritten = rewriteDashManifest({
			mpd,
			mpdUrl: session.entryUrl,
			baseUrl,
			session,
			apiKey,
			registerResource: (url, kind, extension) => {
				const resource = this.store.registerResource(session.token, url, kind, extension);
				if (!resource) {
					throw new Error('Unable to register playback resource');
				}
				return resource.id;
			}
		});

		return new Response(rewritten, {
			status: 200,
			headers: {
				'Content-Type': 'application/dash+xml',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
				'Access-Control-Allow-Headers':
					'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type',
				'Cache-Control': 'no-cache'
			}
		});
	}

	/**
	 * Stream a DASH segment/init resource reconstructed from the session's
	 * MPD-relative path. Session headers (CloudFront cookies) are attached.
	 */
	async renderDashResource(
		session: PlaybackSession,
		upstreamUrl: string,
		request: Request
	): Promise<Response> {
		return this.renderBinaryResponse(session, upstreamUrl, request);
	}

	async renderRegisteredResource(
		session: PlaybackSession,
		resourceId: string,
		baseUrl: string,
		apiKey: string | undefined,
		request: Request
	): Promise<Response> {
		const resource = this.store.getResource(session.token, resourceId);
		if (!resource) {
			return new Response(JSON.stringify({ error: 'Stream resource not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (resource.kind === 'playlist') {
			return this.renderPlaylistResponse(
				session,
				resource.url,
				baseUrl,
				apiKey,
				false,
				resource.segmentFallbackExtension
			);
		}

		let resourceUrl = resource.url;
		if (resourceUrl.includes('$')) {
			const requestUrl = new URL(request.url);
			resourceUrl = resourceUrl.replace(
				/\$([A-Za-z][A-Za-z0-9]*)(?:%0\d+d)?\$/g,
				(match, name: string) => requestUrl.searchParams.get(`dash_${name}`) ?? match
			);
			if (/\$[A-Za-z][A-Za-z0-9]*(?:%0\d+d)?\$/.test(resourceUrl)) {
				return new Response(JSON.stringify({ error: 'Missing DASH template parameter' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		return this.renderBinaryResponse(session, resourceUrl, request, {
			unwrapPngSegment: resource.kind === 'segment'
		});
	}

	async renderDirectResponse(session: PlaybackSession, request: Request): Promise<Response> {
		return this.renderBinaryResponse(session, session.entryUrl, request, {
			fallbackContentType: session.sourceContentType,
			overrideUpstreamContentType: Boolean(session.sourceContentType),
			sniffDirectContainer: true
		});
	}

	/**
	 * Answer a HEAD probe from a media server without streaming the body.
	 * Probes the upstream entry URL with a HEAD request and forwards its
	 * status and the relevant headers (Content-Length, Content-Type, CORS).
	 */
	async renderHeadResponse(session: PlaybackSession, request: Request): Promise<Response> {
		const response = await fetchUpstream(
			session.entryUrl,
			buildUpstreamHeaders(session, request),
			'HEAD'
		);
		const contentType =
			session.sourceType === 'dash'
				? 'application/dash+xml'
				: session.sourceType === 'mp4'
					? 'video/mp4'
					: session.sourceType === 'hls' || session.sourceType === 'm3u8'
						? 'application/vnd.apple.mpegurl'
						: (session.sourceContentType ??
							(isSuspiciousDirectContentType(response.headers.get('content-type'))
								? 'application/octet-stream'
								: detectBinaryContentType(session.entryUrl, response.headers.get('content-type'))));

		return new Response(null, {
			status: response.status,
			headers: buildStreamingResponseHeaders(response, contentType, {
				overrideContentType:
					Boolean(session.sourceContentType) ||
					isSuspiciousDirectContentType(response.headers.get('content-type'))
			})
		});
	}

	async renderSubtitlePlaylist(
		session: PlaybackSession,
		subtitleId: string,
		baseUrl: string,
		apiKey?: string
	): Promise<Response> {
		const subtitle = session.subtitles.find((entry) => entry.id === subtitleId);
		if (!subtitle) {
			return new Response(JSON.stringify({ error: 'Subtitle not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const fileUrl = new URL(
			appendBasePath(baseUrl, `/api/streaming/session/${session.token}/subtitle/${subtitle.id}.vtt`)
		);
		if (apiKey) {
			fileUrl.searchParams.set('api_key', apiKey);
		}

		const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:99999
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:99999.0,
${fileUrl.toString()}
#EXT-X-ENDLIST
`;

		return new Response(playlist, {
			status: 200,
			headers: {
				'Content-Type': 'application/vnd.apple.mpegurl',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Cache-Control': 'no-cache'
			}
		});
	}

	async renderSubtitleFile(session: PlaybackSession, subtitleId: string): Promise<Response> {
		const subtitle = session.subtitles.find((entry) => entry.id === subtitleId);
		if (!subtitle) {
			return new Response(JSON.stringify({ error: 'Subtitle not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const response = await fetchUpstream(subtitle.url, buildUpstreamHeaders(session));
		if (!response.ok) {
			return new Response(JSON.stringify({ error: `Upstream error: ${response.status}` }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const converted = ensureVttFormat(await readBodyWithLimit(response, MAX_SUBTITLE_BYTES));
		if (converted === null) {
			// ASS/SSA or unknown binary content: never relabel as text/vtt.
			return new Response(
				JSON.stringify({ error: 'Subtitle format is not convertible to WebVTT' }),
				{
					status: 415,
					headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
				}
			);
		}
		const content = converted;
		return new Response(content, {
			status: 200,
			headers: {
				'Content-Type': 'text/vtt; charset=utf-8',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Cache-Control': 'public, max-age=3600'
			}
		});
	}

	private async renderPlaylistResponse(
		session: PlaybackSession,
		playlistUrl: string,
		baseUrl: string,
		apiKey: string | undefined,
		injectSubtitles: boolean,
		segmentFallbackExtension?: string
	): Promise<Response> {
		const response = await fetchUpstream(playlistUrl, buildUpstreamHeaders(session));
		if (!response.ok) {
			return new Response(JSON.stringify({ error: `Upstream error: ${response.status}` }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		let playlist = await readBodyWithLimit(response, MAX_TEXT_RESPONSE_BYTES);
		if (!isHLSPlaylist(playlist)) {
			return new Response(JSON.stringify({ error: 'Invalid HLS playlist' }), {
				status: 502,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const validation = validatePlaylist(playlist);
		if (!validation.valid) {
			playlist = sanitizePlaylist(playlist);
		}

		const rewritten = rewriteSessionPlaylist({
			playlist,
			playlistUrl,
			baseUrl,
			session,
			apiKey,
			injectSubtitles,
			segmentFallbackExtension,
			registerResource: (url, kind, extension, childSegmentFallbackExtension) => {
				const resource = this.store.registerResource(
					session.token,
					url,
					kind,
					extension,
					childSegmentFallbackExtension
				);
				if (!resource) {
					throw new Error('Unable to register playback resource');
				}
				return resource.id;
			}
		});

		return new Response(rewritten, {
			status: 200,
			headers: {
				'Content-Type': 'application/vnd.apple.mpegurl',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
				'Access-Control-Allow-Headers':
					'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type',
				'Cache-Control': 'no-cache'
			}
		});
	}

	private async renderBinaryResponse(
		session: PlaybackSession,
		url: string,
		request: Request,
		options: {
			fallbackContentType?: string;
			overrideUpstreamContentType?: boolean;
			sniffDirectContainer?: boolean;
			unwrapPngSegment?: boolean;
		} = {}
	): Promise<Response> {
		const response = await fetchUpstream(
			url,
			buildUpstreamHeaders(session, request),
			request.method === 'HEAD' ? 'HEAD' : 'GET'
		);
		if (!response.ok) {
			return new Response(responseMayHaveBody(response.status) ? response.body : null, {
				status: response.status,
				statusText: response.statusText,
				headers: buildStreamingResponseHeaders(
					response,
					response.headers.get('content-type') ?? 'application/octet-stream'
				)
			});
		}

		const upstreamContentType = response.headers.get('content-type');
		let body = response.body;
		let contentType =
			options.fallbackContentType ?? detectBinaryContentType(url, upstreamContentType);
		let overrideContentType = Boolean(options.overrideUpstreamContentType);
		let bodyLengthChanged = false;

		if (options.unwrapPngSegment && upstreamContentType?.includes('image/png') && body) {
			const arrayBuffer = await new Response(body).arrayBuffer();
			const bytes = new Uint8Array(arrayBuffer);
			let bodyReplaced = false;
			if (isPngWrappedSegment(bytes, upstreamContentType)) {
				const stripped = stripPngWrapper(bytes);
				if (stripped) {
					logger.debug(
						{
							sessionToken: session.token,
							provider: session.provider,
							resourceUrl: url.substring(0, 100),
							wrapperSize: bytes.length - stripped.length,
							tsSize: stripped.length,
							...streamLog
						},
						'Stripped PNG wrapper from CDN segment'
					);
					body = new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(stripped));
							controller.close();
						}
					});
					contentType = 'video/mp2t';
					bodyReplaced = true;
					overrideContentType = true;
					bodyLengthChanged = true;
				}
			}
			if (!bodyReplaced) {
				body = new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					}
				});
			}
		}

		const range = request.headers.get('range');
		const maySniff = !range || /^bytes=0-/i.test(range);
		if (
			options.sniffDirectContainer &&
			body &&
			maySniff &&
			!options.fallbackContentType &&
			isSuspiciousDirectContentType(upstreamContentType)
		) {
			const peeked = await peekStream(body);
			body = peeked.body;
			contentType = sniffVideoContentType(peeked.prefix) ?? 'application/octet-stream';
			overrideContentType = true;
		} else if (
			options.sniffDirectContainer &&
			!options.fallbackContentType &&
			isSuspiciousDirectContentType(upstreamContentType)
		) {
			contentType = 'application/octet-stream';
			overrideContentType = true;
		}

		logger.debug(
			{
				sessionToken: session.token,
				provider: session.provider,
				resourceUrl: url,
				contentType,
				...streamLog
			},
			'Proxying playback session resource'
		);

		return new Response(body, {
			status: response.status,
			headers: buildStreamingResponseHeaders(response, contentType, {
				overrideContentType,
				bodyLengthChanged
			})
		});
	}
}

let sessionProxyServiceInstance: SessionProxyService | null = null;

export function getSessionProxyService(): SessionProxyService {
	if (!sessionProxyServiceInstance) {
		sessionProxyServiceInstance = new SessionProxyService();
	}

	return sessionProxyServiceInstance;
}

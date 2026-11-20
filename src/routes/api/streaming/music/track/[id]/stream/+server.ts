import { statSync } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	invalidateTrackStream,
	resolveTrackStream,
	type TrackStream
} from '#lib/server/music/playback/resolver.js';
import { warmAlbum } from '#lib/server/music/playback/warmer.js';
import { serveLocalFile } from '#lib/server/streaming/local-file.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MusicTrackStream', logDomain: 'streams' });

/** Headers the browser needs to seek and to know what it is decoding. */
const PASSTHROUGH_HEADERS = [
	'content-type',
	'content-length',
	'content-range',
	'accept-ranges',
	'etag',
	'last-modified'
];

function authorized(event: RequestEvent): boolean {
	return Boolean(event.locals.apiKey || event.locals.user);
}

interface UpstreamRequest {
	headers: Headers;
	/** We asked for a range the client never did, so the reply must look like a plain 200. */
	syntheticRange: boolean;
}

/**
 * Provider URLs must be fetched with a range.
 *
 * googlevideo answers a plain GET with 200 and then throttles the body to
 * ~30 KB/s; the same file requested as `bytes=0-` returns 206 at line speed.
 * Jellyfin's `.strm` audio plugin never sends a Range header, so a proxied
 * track used to arrive at roughly realtime bitrate — seconds of buffering
 * before the music starts, and a fresh wait on every skip.
 */
function upstreamRequest(request: Request): UpstreamRequest {
	const headers = new Headers();
	const range = request.headers.get('range');
	if (range) {
		headers.set('Range', range);
		const ifRange = request.headers.get('if-range');
		if (ifRange) headers.set('If-Range', ifRange);
		return { headers, syntheticRange: false };
	}

	headers.set('Range', 'bytes=0-');
	return { headers, syntheticRange: true };
}

async function fetchUpstream(stream: TrackStream, request: UpstreamRequest): Promise<Response> {
	return fetch(stream.url, { headers: request.headers, redirect: 'follow' });
}

function proxyResponse(upstream: Response, syntheticRange: boolean): Response {
	if (!upstream.ok && upstream.status !== 206) {
		return new Response('Upstream rejected the stream', { status: 502 });
	}

	const headers = new Headers();
	for (const name of PASSTHROUGH_HEADERS) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set('Cache-Control', 'no-cache');

	// A 206 answers a request nobody made. The client asked for the whole file,
	// so drop the partial-content marker and let the full length stand.
	if (syntheticRange && upstream.status === 206) {
		headers.delete('content-range');
		return new Response(upstream.body, { status: 200, headers });
	}

	return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * GET /api/streaming/music/track/{id}/stream
 *
 * Local files are served straight from disk with Range support. Provider audio
 * is proxied: the direct URL is bound to the server's address and expires, so
 * the browser never sees it. A 403/410 from the provider is treated as an
 * expired URL — resolve once more, then give up.
 */
export const GET: RequestHandler = async (event) => {
	if (!authorized(event)) return new Response('Unauthorized', { status: 401 });

	const outcome = await resolveTrackStream(event.params.id);
	if (outcome.status !== 'ok') {
		const status = outcome.status === 'provider-unavailable' ? 503 : 404;
		return new Response('Track is not playable', { status });
	}

	if (outcome.stream.source === 'local') {
		try {
			const stats = statSync(outcome.stream.url);
			return serveLocalFile(event.request, {
				absolutePath: outcome.stream.url,
				size: stats.size,
				contentType: outcome.stream.contentType
			});
		} catch {
			logger.warn({ trackId: event.params.id }, '[MusicStream] Local file vanished before serving');
			return new Response('Track file not found', { status: 404 });
		}
	}

	// Playing one track of a streaming album is the signal to get the rest
	// ready: the next skip should not pay the resolver's seconds again.
	warmAlbum(outcome.albumId);

	const upstream = upstreamRequest(event.request);
	let response = await fetchUpstream(outcome.stream, upstream);
	if (response.status === 403 || response.status === 410) {
		logger.info(
			{ trackId: event.params.id, status: response.status },
			'[MusicStream] Provider URL expired, re-resolving'
		);
		invalidateTrackStream(event.params.id);
		const retry = await resolveTrackStream(event.params.id);
		if (retry.status === 'ok' && retry.stream.source === 'youtube') {
			response = await fetchUpstream(retry.stream, upstream);
		}
	}

	return proxyResponse(response, upstream.syntheticRange);
};

/** HEAD stays cheap: no provider call just to answer a metadata question. */
export const HEAD: RequestHandler = async (event) => {
	if (!authorized(event)) return new Response(null, { status: 401 });
	return new Response(null, {
		status: 200,
		headers: { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes' }
	});
};

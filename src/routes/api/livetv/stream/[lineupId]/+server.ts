/**
 * Live TV Stream Proxy
 *
 * Proxies Live TV streams from all provider sources (Stalker, XStream, M3U).
 * Handles stream URL resolution, HLS-to-TS conversion, and direct stream passthrough.
 *
 * STREAMING MODES:
 *
 * 1. Default (no format param) — Server-side HLS-to-TS conversion
 *    This is the primary mode, used by media servers (Jellyfin/Plex/Emby) when
 *    they tune to a channel from the M3U playlist. Media servers' M3U tuners
 *    expect a continuous MPEG-TS byte stream — they cannot consume HLS playlists.
 *    The HlsToTsConverter fetches HLS playlists from the portal (getting a fresh
 *    play_token via createLink each cycle), downloads segments in sequence order,
 *    and pipes them as one continuous TS stream. This avoids the stalker portal
 *    replay issue entirely (see below).
 *
 * 2. HLS mode (format=hls) — Returns the raw HLS playlist with rewritten URLs
 *    Segment URLs are rewritten to go through the segment proxy at
 *    /api/livetv/stream/:lineupId/segment.ts. Used by HLS-aware clients that
 *    can handle playlist refreshes themselves.
 *
 * 3. Direct TS mode (format=ts) — Resolve URL, fetch, pipe body directly
 *    No reconnection logic. When upstream closes (~24s on stalker), response ends.
 *    WARNING: Stalker portals cause ~20s content overlap/replay on reconnect
 *    because play_tokens are single-use and the server restarts from its internal
 *    buffer origin each time. This mode exists for debugging or non-stalker sources.
 *
 * STALKER PORTAL REPLAY ISSUE (why default mode uses HLS-to-TS):
 *    Stalker portal play_tokens are single-use. In raw TS mode, each token yields
 *    ~24 seconds of wall-clock streaming before the server closes the connection.
 *    On reconnect with a new token, the server replays ~20 seconds of overlapping
 *    content from its buffer origin, creating a visible 30-45 second loop. HLS
 *    mode avoids this because segments are individually addressable via hash-based
 *    backend URLs, and sequence tracking prevents delivering duplicate segments.
 *
 * ENDPOINTS:
 *    GET  /api/livetv/stream/:lineupId              (HLS-to-TS conversion)
 *    GET  /api/livetv/stream/:lineupId?format=hls   (HLS playlist passthrough)
 *    GET  /api/livetv/stream/:lineupId?format=ts    (direct TS pipe)
 *    HEAD /api/livetv/stream/:lineupId               (content-type probe)
 */

import type { RequestHandler } from './$types';
import {
	handleStreamGet,
	handleStreamHead,
	handleStreamOptions
} from '#lib/server/livetv/streaming/StreamRequestHandler.js';

export const GET: RequestHandler = async ({ params, request, url }) => {
	const { lineupId } = params;

	if (!lineupId) {
		return new Response(JSON.stringify({ error: 'Missing lineup ID' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	return handleStreamGet(lineupId, request, url);
};

export const HEAD: RequestHandler = async ({ params, url, request }) => {
	const { lineupId } = params;

	if (!lineupId) {
		return new Response(null, { status: 400 });
	}

	return handleStreamHead(lineupId, url, request.signal);
};

export const OPTIONS: RequestHandler = async () => {
	return handleStreamOptions();
};

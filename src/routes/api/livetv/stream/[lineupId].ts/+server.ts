/**
 * Stream endpoint with .ts extension
 *
 * This route exists solely to make the stream URLs end in .ts, which
 * helps media servers (Jellyfin/Plex/Emby) auto-detect the format as
 * MPEG-TS rather than forcing HLS format detection.
 *
 * All requests are forwarded to the shared stream handler.
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

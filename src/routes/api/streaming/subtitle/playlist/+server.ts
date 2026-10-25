/**
 * Subtitle Playlist Endpoint
 *
 * Generates a minimal HLS playlist for subtitle tracks.
 * HLS requires subtitle tracks to have their own playlist that
 * points to the actual subtitle file (VTT format).
 *
 * GET /api/streaming/subtitle/playlist?url=<encoded_url>&referer=<encoded_referer>
 */

import type { RequestHandler } from './$types';
import { getBaseUrl } from '#lib/server/streaming/url.js';

export const GET: RequestHandler = async ({ url, request }) => {
	const subtitleUrl = url.searchParams.get('url');
	const referer = url.searchParams.get('referer') || '';

	if (!subtitleUrl) {
		return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const baseUrl = getBaseUrl(request);

	// Build proxy URL for the actual subtitle file
	const params = new URLSearchParams();
	params.set('url', subtitleUrl);
	if (referer) {
		params.set('referer', referer);
	}
	const proxyUrl = `${baseUrl}/api/streaming/subtitle?${params.toString()}`;

	// Generate a minimal HLS subtitle playlist
	// This playlist wraps the subtitle file as an HLS-compatible WebVTT segment
	// The TARGETDURATION is set high since subtitles span the entire video
	const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:99999
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:99999.0,
${proxyUrl}
#EXT-X-ENDLIST
`;

	return new Response(playlist, {
		status: 200,
		headers: {
			'Content-Type': 'application/vnd.apple.mpegurl',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Cache-Control': 'public, max-age=3600'
		}
	});
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

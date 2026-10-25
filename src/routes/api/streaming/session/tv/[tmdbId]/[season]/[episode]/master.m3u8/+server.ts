import type { RequestHandler } from './$types';
import { getBaseUrlAsync } from '#lib/server/streaming/index.js';

/**
 * Legacy .strm entry points end in master.m3u8; the native endpoints dropped
 * the suffix so media servers treat the source as remuxable. The target is
 * built from the configured base URL rather than request.url, which can be a
 * non-routable origin (e.g. https://localhost) behind a proxy — a malformed
 * Location fails hard for ffmpeg-based clients like Jellyfin, surfacing as
 * "FFmpeg exited with code 251".
 */
async function redirectToNativeEndpoint(request: Request): Promise<Response> {
	const source = new URL(request.url);
	const target =
		(await getBaseUrlAsync(request)) +
		source.pathname.replace(/\/master\.m3u8$/, '') +
		source.search;
	return new Response(null, { status: 307, headers: { Location: target } });
}

export const GET: RequestHandler = async ({ request }) => redirectToNativeEndpoint(request);

export const HEAD: RequestHandler = async ({ request }) => redirectToNativeEndpoint(request);

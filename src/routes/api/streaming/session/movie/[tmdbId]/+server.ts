import type { RequestHandler } from './$types';
import {
	getBaseUrlAsync,
	getPlaybackSessionService,
	getSessionProxyService,
	type PlaybackSession
} from '#lib/server/streaming/index.js';

function errorResponse(message: string, code: string, status: number): Response {
	return new Response(JSON.stringify({ error: message, code }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function wantsRefresh(url: URL): boolean {
	const refresh = url.searchParams.get('refresh');
	return refresh === '1' || refresh === 'true';
}

async function resolveMovieSession(
	tmdbId: string,
	forceRefresh: boolean
): Promise<{ session: PlaybackSession | null; error?: string; invalid?: boolean }> {
	if (!tmdbId || !/^\d+$/.test(tmdbId)) {
		return { session: null, error: undefined, invalid: true };
	}
	return getPlaybackSessionService().createOrReuseSession({
		tmdbId: parseInt(tmdbId, 10),
		type: 'movie',
		forceRefresh
	});
}

/**
 * GET /api/streaming/session/movie/{tmdbId}
 *
 * Source-aware launch entry for .strm files. The path deliberately has no
 * `.m3u` suffix so media servers (Jellyfin) treat the source as remuxable —
 * Jellyfin's SupportsDirectStream rejects any HTTP path containing `.m3u`.
 * Each source keeps its real format: manifests are only rewritten to retain
 * authenticated proxy URLs, while direct containers are streamed unchanged.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const { session, error, invalid } = await resolveMovieSession(params.tmdbId, wantsRefresh(url));
	if (invalid) {
		return errorResponse('Invalid TMDB ID', 'INVALID_PARAM', 400);
	}
	if (!session) {
		return errorResponse(error || 'No playable stream found', 'PLAYBACK_UNAVAILABLE', 503);
	}

	const baseUrl = await getBaseUrlAsync(request);
	const apiKey = url.searchParams.get('api_key') || request.headers.get('x-api-key') || undefined;

	return await getSessionProxyService().renderLaunchMedia(session, baseUrl, apiKey, request);
};

export const HEAD: RequestHandler = async ({ params, request, url }) => {
	const { session, error, invalid } = await resolveMovieSession(params.tmdbId, wantsRefresh(url));
	if (invalid) {
		return errorResponse('Invalid TMDB ID', 'INVALID_PARAM', 400);
	}
	if (!session) {
		return errorResponse(error || 'No playable stream found', 'PLAYBACK_UNAVAILABLE', 503);
	}

	return await getSessionProxyService().renderHeadResponse(session, request);
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 200,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
			'Access-Control-Allow-Headers':
				'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type'
		}
	});
};

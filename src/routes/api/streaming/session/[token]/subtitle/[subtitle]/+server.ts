import type { RequestHandler } from './$types';
import {
	getBaseUrlAsync,
	getPlaybackSessionStore,
	getSessionProxyService
} from '#lib/server/streaming/index.js';

function normalizeSubtitleId(subtitle: string): string {
	return subtitle.replace(/\.(m3u8|vtt)$/i, '');
}

export const GET: RequestHandler = async ({ params, request, url }) => {
	const session = getPlaybackSessionStore().getSession(params.token);
	if (!session) {
		return new Response(JSON.stringify({ error: 'Streaming session not found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const subtitleId = normalizeSubtitleId(params.subtitle);
	const apiKey = url.searchParams.get('api_key') || request.headers.get('x-api-key') || undefined;
	if (params.subtitle.endsWith('.m3u8')) {
		const baseUrl = await getBaseUrlAsync(request);
		return await getSessionProxyService().renderSubtitlePlaylist(
			session,
			subtitleId,
			baseUrl,
			apiKey
		);
	}

	return await getSessionProxyService().renderSubtitleFile(session, subtitleId);
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

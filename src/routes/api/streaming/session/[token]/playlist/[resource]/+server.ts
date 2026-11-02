import type { RequestHandler } from './$types';
import {
	getBaseUrlAsync,
	getPlaybackSessionStore,
	getSessionProxyService
} from '#lib/server/streaming/index.js';

function normalizeResourceId(resource: string): string {
	return resource.replace(/\.m3u8$/i, '');
}

export const GET: RequestHandler = async ({ params, request, url }) => {
	const session = getPlaybackSessionStore().getSession(params.token);
	if (!session) {
		return new Response(JSON.stringify({ error: 'Streaming session not found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const baseUrl = await getBaseUrlAsync(request);
	const apiKey = url.searchParams.get('api_key') || request.headers.get('x-api-key') || undefined;
	return await getSessionProxyService().renderRegisteredResource(
		session,
		normalizeResourceId(params.resource),
		baseUrl,
		apiKey,
		request
	);
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 200,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers':
				'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type'
		}
	});
};

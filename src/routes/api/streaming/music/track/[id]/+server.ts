import type { RequestHandler } from './$types.js';
import { resolveTrackStream } from '#lib/server/music/playback/resolver.js';

/**
 * GET /api/streaming/music/track/{id}
 *
 * What the player needs before it presses play: where the audio comes from and
 * the stable URL it should load. The upstream URL is never exposed — playback
 * always goes through the proxy below, which keeps Range semantics and hides
 * expiring provider links.
 */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.apiKey && !event.locals.user) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const outcome = await resolveTrackStream(event.params.id);
	if (outcome.status === 'ok') {
		return Response.json({
			success: true,
			trackId: event.params.id,
			source: outcome.stream.source,
			contentType: outcome.stream.contentType,
			streamUrl: `/api/streaming/music/track/${event.params.id}/stream`,
			expiresAt: outcome.stream.expiresAt
		});
	}

	if (outcome.status === 'provider-unavailable') {
		return Response.json(
			{ error: 'Track is not playable right now', details: outcome.detail },
			{ status: 503 }
		);
	}

	return Response.json(
		{
			error:
				outcome.status === 'not-stream-backed'
					? 'No local file and this album is not stream-backed'
					: 'Track not found'
		},
		{ status: 404 }
	);
};

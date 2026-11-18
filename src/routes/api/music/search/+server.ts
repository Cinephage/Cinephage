import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';
import { musicBrainz, MusicBrainzError } from '#lib/server/music/musicbrainz.js';

const logger = createChildLogger({ module: 'MusicSearchApi', logDomain: 'system' });

/**
 * GET /api/music/search?artist=&album=
 *
 * Release-group search, i.e. albums — not tracks. At least one term is
 * required: MusicBrainz has no useful "everything" query, and an empty search
 * would be a free way to burn the shared 1 req/s budget.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const artist = event.url.searchParams.get('artist')?.trim() ?? '';
	const album = event.url.searchParams.get('album')?.trim() ?? '';
	if (!artist && !album) {
		return Response.json({ error: 'An artist or album is required' }, { status: 400 });
	}

	try {
		const results = await musicBrainz.searchReleaseGroups({
			artist: artist || undefined,
			album: album || undefined,
			limit: 20
		});
		return Response.json({ success: true, results });
	} catch (err) {
		const retryable = err instanceof MusicBrainzError && err.retryable;
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err), retryable },
			'[MusicSearch] MusicBrainz search failed'
		);
		return Response.json(
			{
				error: 'MusicBrainz search failed',
				details: err instanceof Error ? err.message : String(err),
				retryable
			},
			{ status: 502 }
		);
	}
};

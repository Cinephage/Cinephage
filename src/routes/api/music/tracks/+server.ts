import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { musicTrackService } from '#lib/server/music/MusicTrackService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

const querySchema = z.object({
	q: z.string().trim().max(200).optional(),
	file: z.enum(['all', 'downloaded', 'missing']).default('all'),
	libraryId: z.string().trim().min(1).optional(),
	quality: z.string().trim().min(1).optional(),
	sort: z.enum(['title-asc', 'artist-asc', 'album-asc', 'duration-desc']).default('title-asc'),
	offset: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(180).default(90)
});

/** GET /api/music/tracks — the Songs tab, one window at a time. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const parsed = querySchema.safeParse(Object.fromEntries(event.url.searchParams));
	if (!parsed.success) {
		return Response.json({ error: 'Invalid query' }, { status: 400 });
	}

	const { quality, ...page } = parsed.data;
	const albumIds = quality ? musicAlbumService.albumIdsForEffectiveProfile(quality) : undefined;
	const { rows, total } = musicTrackService.listTracksPage({ ...page, albumIds });
	return Response.json({
		success: true,
		tracks: rows,
		total,
		hasMore: parsed.data.offset + rows.length < total
	});
};

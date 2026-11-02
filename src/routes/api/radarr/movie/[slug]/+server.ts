import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { db } from '#lib/server/db/index.js';
import { movies } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * GET /api/radarr/movie/{titleSlug} - real Radarr serves its own web UI
 * from the same origin/base path as its API, so arr clients build an
 * "Open in Radarr" link as `{configuredBaseUrl}/movie/{titleSlug}`
 * (Seerr does exactly this, reusing the same URL configured for the API).
 * Cinephage has no such page under this path - redirect to the real
 * library page instead of 404ing. `titleSlug` is the movie's tmdbId (see
 * movieShape.ts's titleSlugFor - Cinephage has no separate slug concept).
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const tmdbId = Number.parseInt(event.params.slug, 10);
	if (Number.isNaN(tmdbId)) error(400, 'Invalid movie slug');

	const [movie] = await db
		.select({ id: movies.id })
		.from(movies)
		.where(eq(movies.tmdbId, tmdbId))
		.limit(1);

	// Not (yet) in the library - send to the discover/add page instead of
	// a dead end.
	redirect(302, movie ? `/library/movie/${movie.id}` : `/discover/movie/${tmdbId}`);
};

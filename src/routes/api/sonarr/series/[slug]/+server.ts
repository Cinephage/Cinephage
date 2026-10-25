import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * GET /api/sonarr/series/{titleSlug} - see the Radarr movie/[slug] route
 * for why this exists (real Sonarr serves its web UI from the same
 * base path as its API; Seerr's "Open in Sonarr" link relies on that).
 * `titleSlug` is the series' tmdbId (see movieShape.ts's titleSlugFor).
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const tmdbId = Number.parseInt(event.params.slug, 10);
	if (Number.isNaN(tmdbId)) error(400, 'Invalid series slug');

	const [item] = await db
		.select({ id: series.id })
		.from(series)
		.where(eq(series.tmdbId, tmdbId))
		.limit(1);

	redirect(302, item ? `/library/tv/${item.id}` : `/discover/tv/${tmdbId}`);
};

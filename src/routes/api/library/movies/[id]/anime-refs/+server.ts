import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { movies, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getMetadataProviderConfig } from '#lib/server/metadata/provider-settings.js';
import { resolveMissingAnimeProviderRefs } from '#lib/server/metadata/provider-ref-resolver.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MovieAnimeRefs', logDomain: 'scans' });

function isAnimeMovieSignal(input: {
	rootFolderPath: string | null;
	genres: string[] | null;
	title: string;
}): boolean {
	const path = (input.rootFolderPath ?? '').toLowerCase();
	if (path.includes('/anime/')) return true;
	const genres = input.genres ?? [];
	if (genres.some((genre) => genre.toLowerCase() === 'animation')) return true;
	return /\banime\b/i.test(input.title);
}

/**
 * GET /api/library/movies/[id]/anime-refs
 *
 * AniList/Jikan(MAL) provider-ref lookup, split out from the page load so the
 * movie detail page never blocks its first paint on a slow/rate-limited
 * upstream (see +page.server.ts for the full rationale - this replaces
 * trying to stream the lookup through SvelteKit's promise-streaming, which
 * still visibly delayed first paint in practice, likely because something
 * between the app and the browser buffers the response). The client calls
 * this after the page has already rendered and merges the result in.
 */
export const GET: RequestHandler = async ({ params }) => {
	const [movie] = await db
		.select({
			id: movies.id,
			title: movies.title,
			originalTitle: movies.originalTitle,
			year: movies.year,
			genres: movies.genres,
			providerRefs: movies.providerRefs,
			rootFolderPath: rootFolders.path
		})
		.from(movies)
		.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
		.where(eq(movies.id, params.id));

	if (!movie) {
		return Response.json({ success: false, error: 'Movie not found' }, { status: 404 });
	}

	const existingRefs =
		(movie.providerRefs as Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null) ?? undefined;
	const providerConfig = await getMetadataProviderConfig();

	const refs = await resolveMissingAnimeProviderRefs({
		title: movie.title,
		aliases: [movie.originalTitle ?? ''],
		year: movie.year,
		isAnime: isAnimeMovieSignal({
			rootFolderPath: movie.rootFolderPath ?? null,
			genres: (movie.genres as string[] | null) ?? null,
			title: movie.title
		}),
		configured: {
			anilist: providerConfig.animeEnrichmentEnabled,
			mal: providerConfig.animeEnrichmentEnabled
		},
		existingRefs
	});

	const hasNewRefs = (['anilist', 'mal'] as const).some(
		(providerId) => refs[providerId] && !existingRefs?.[providerId]
	);
	if (hasNewRefs) {
		await db
			.update(movies)
			.set({ providerRefs: refs })
			.where(eq(movies.id, movie.id))
			.catch((err) => {
				logger.warn(
					{ movieId: movie.id, error: err instanceof Error ? err.message : String(err) },
					'Failed to persist resolved anime provider refs'
				);
			});
	}

	return Response.json({ success: true, providerRefs: refs });
};

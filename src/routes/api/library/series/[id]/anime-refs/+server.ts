import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getMetadataProviderConfig } from '#lib/server/metadata/provider-settings.js';
import { resolveMissingAnimeProviderRefs } from '#lib/server/metadata/provider-ref-resolver.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SeriesAnimeRefs', logDomain: 'scans' });

/**
 * GET /api/library/series/[id]/anime-refs
 *
 * AniList/Jikan(MAL) provider-ref lookup, split out from the page load so
 * the series detail page never blocks its first paint on a slow/rate-limited
 * upstream (see +page.server.ts for the full rationale - this replaces
 * trying to stream the lookup through SvelteKit's promise-streaming, which
 * still visibly delayed first paint in practice, likely because something
 * between the app and the browser buffers the response). The client calls
 * this after the page has already rendered and merges the result in.
 */
export const GET: RequestHandler = async ({ params }) => {
	const [seriesData] = await db
		.select({
			id: series.id,
			title: series.title,
			originalTitle: series.originalTitle,
			year: series.year,
			seriesType: series.seriesType,
			providerRefs: series.providerRefs
		})
		.from(series)
		.where(eq(series.id, params.id));

	if (!seriesData) {
		return Response.json({ success: false, error: 'Series not found' }, { status: 404 });
	}

	const existingRefs =
		(seriesData.providerRefs as Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null) ??
		undefined;
	const providerConfig = await getMetadataProviderConfig();

	const refs = await resolveMissingAnimeProviderRefs({
		title: seriesData.title,
		aliases: [seriesData.originalTitle ?? ''],
		year: seriesData.year,
		isAnime: (seriesData.seriesType ?? '').toLowerCase() === 'anime',
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
			.update(series)
			.set({ providerRefs: refs })
			.where(eq(series.id, seriesData.id))
			.catch((err) => {
				logger.warn(
					{ seriesId: seriesData.id, error: err instanceof Error ? err.message : String(err) },
					'Failed to persist resolved anime provider refs'
				);
			});
	}

	return Response.json({ success: true, providerRefs: refs });
};

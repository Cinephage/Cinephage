/**
 * Anime metadata enrichment helpers.
 *
 * Anime providers (AniList, Jikan) are supplementary to TMDB. They contribute:
 *   - adult/hentai flag (WP-Q)
 *   - alternate / romaji titles (feeds alternate-title store for search)
 *   - additive genre tags (merged onto TMDB genres, never replacing)
 *
 * TMDB is always the canonical identity/overview/display record.
 */

import { buildMetadataProviderRegistry } from './provider-registry.js';
import { resolveAnimeProviderRef } from './provider-ref-resolver.js';
import type { MetadataDetails, MetadataMediaType, MetadataProviderId } from './providers/types.js';
import { storeProviderTitleVariants } from '#lib/server/services/AlternateTitleService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export interface AnimeEnrichmentInput {
	tmdbTitle: string;
	aliases: string[];
	year?: number | null;
	/** TMDB id of the media being enriched - used for conflict tracking */
	tmdbId?: number;
}

export interface AnimeEnrichmentResult {
	/** Refs keyed by provider id ('anilist', 'mal') for storage in providerRefs */
	refs: Record<string, string>;
	/** Provider details from each provider that resolved, for adult flag and alt-title extraction */
	details: Record<string, MetadataDetails>;
}

/**
 * Fetch supplementary anime enrichment from AniList and Jikan.
 * Returns empty if enrichment is disabled in config.
 * Always fails soft: a provider outage does not throw.
 */
export async function enrichAnimeMetadata(
	input: AnimeEnrichmentInput,
	mediaType: MetadataMediaType
): Promise<AnimeEnrichmentResult> {
	const result: AnimeEnrichmentResult = { refs: {}, details: {} };

	const registry = await buildMetadataProviderRegistry();
	if (!registry.enrichmentEnabled) return result;

	const providerIds = ['anilist', 'mal'] as const;
	const providerResults: Record<string, { found: boolean; id?: string; error?: string }> = {};
	const configuredProviders: string[] = [];

	await Promise.all(
		providerIds.map(async (providerId) => {
			const provider = registry.providers.get(providerId);
			if (!provider?.isConfigured()) return;
			configuredProviders.push(providerId);

			try {
				const ref = await resolveAnimeProviderRef({
					providerId,
					title: input.tmdbTitle,
					aliases: input.aliases,
					year: input.year ?? undefined
				});
				if (!ref) {
					providerResults[providerId] = { found: false };
					return;
				}

				const details = await provider.getDetails(ref, mediaType);
				if (!details) {
					providerResults[providerId] = { found: false };
					return;
				}

				result.refs[providerId] = ref;
				result.details[providerId] = details;
				providerResults[providerId] = { found: true, id: ref };
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				providerResults[providerId] = { found: false, error };
				logger.warn(
					{ providerId, title: input.tmdbTitle, error },
					'[AnimeEnrichment] Provider failed - skipping'
				);
			}
		})
	);

	return result;
}

/**
 * Persist the title variants carried by anime enrichment details
 * (enrichment.details from enrichAnimeMetadata) as alternate titles with
 * source 'anilist'/'mal'. Storage is idempotent (dedupe by source+cleanTitle),
 * so repeat refreshes never duplicate rows. Never throws.
 */
export async function persistEnrichmentTitleVariants(
	mediaType: 'movie' | 'series',
	mediaId: string,
	details: Record<string, MetadataDetails>
): Promise<number> {
	let stored = 0;
	for (const providerId of ['anilist', 'mal'] as const) {
		const variants = details[providerId]?.alternateTitles;
		if (!variants || variants.length === 0) continue;
		stored += await storeProviderTitleVariants(mediaType, mediaId, providerId, variants);
	}
	return stored;
}

/**
 * Fetch details for already-linked anime provider refs (manual link path) and
 * persist their title variants as alternate titles. Used when a user sets
 * anilist/mal ids directly on a movie/series; storage is idempotent. Never throws.
 */
export async function persistLinkedProviderTitleVariants(
	mediaType: 'movie' | 'series',
	mediaId: string,
	refs: Partial<Record<MetadataProviderId, string>> | null | undefined
): Promise<number> {
	if (!refs?.anilist && !refs?.mal) return 0;

	try {
		const { providers } = await buildMetadataProviderRegistry();
		let stored = 0;

		for (const providerId of ['anilist', 'mal'] as const) {
			const ref = refs[providerId];
			if (!ref) continue;
			const provider = providers.get(providerId);
			if (!provider?.isConfigured()) continue;

			const details = await provider.getDetails(ref, 'anime');
			if (!details?.alternateTitles?.length) continue;
			stored += await storeProviderTitleVariants(
				mediaType,
				mediaId,
				providerId,
				details.alternateTitles
			);
		}

		return stored;
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.warn(
			{ mediaType, mediaId, error },
			'[AnimeEnrichment] Failed to persist linked provider title variants - skipping'
		);
		return 0;
	}
}

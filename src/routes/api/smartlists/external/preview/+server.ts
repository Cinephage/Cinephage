/**
 * External List Preview API
 * POST /api/smartlists/external/preview - Preview external list items
 * POST /api/smartlists/external/test - Test external list connection
 */

import type { RequestHandler } from './$types';
import { providerRegistry } from '#lib/server/smartlists/providers/ProviderRegistry.js';
import { externalIdResolver } from '#lib/server/smartlists/ExternalIdResolver.js';
import { presetService } from '#lib/server/smartlists/presets/PresetService.js';
import { createChildLogger } from '#lib/logging/index.js';
import { z } from 'zod';
import { smartListExternalPreviewSchema } from '#lib/validation/schemas.js';
import { contentFilterPipeline } from '#lib/server/filters/ContentFilterPipeline.js';

const logger = createChildLogger({
	module: 'SmartListsExternalPreviewApi',
	logDomain: 'monitoring'
});

export const POST: RequestHandler = async ({ request, url }) => {
	const isTest = url.pathname.endsWith('/test');

	try {
		const body = await request.json();
		const data = smartListExternalPreviewSchema.parse(body);

		let providerType: string;
		let providerConfig: Record<string, unknown>;

		// Determine provider type and config
		if (data.presetId) {
			// Using a preset - extract provider from preset ID
			const preset = presetService.getPreset(data.presetId);
			if (!preset) {
				return Response.json({ error: 'Preset not found' }, { status: 404 });
			}

			providerType = preset.provider;

			// Build config from preset config + user settings
			providerConfig = {
				...preset.config,
				...data.config
			};

			// For external-json provider, also include URL
			if (preset.url) {
				providerConfig.url = preset.url;
				providerConfig.headers = data.headers;
			}

			logger.info(
				{
					presetId: data.presetId,
					providerType,
					config: providerConfig
				},
				'[ExternalPreview API] Using preset'
			);
		} else if (data.providerType) {
			// Using explicit provider type with custom config
			providerType = data.providerType;
			providerConfig = data.config ?? {};

			// For external-json provider, include URL
			if (providerType === 'external-json' && data.url) {
				providerConfig.url = data.url;
				providerConfig.headers = data.headers;
			}

			logger.info(
				{
					providerType,
					config: providerConfig
				},
				'[ExternalPreview API] Using provider type'
			);
		} else if (data.url) {
			// Fallback to external-json for backward compatibility
			providerType = 'external-json';
			providerConfig = {
				url: data.url,
				headers: data.headers
			};

			logger.info(
				{
					url: data.url
				},
				'[ExternalPreview API] Using URL (backward compatibility)'
			);
		} else {
			return Response.json(
				{ error: 'Must provide presetId, providerType, or url' },
				{ status: 400 }
			);
		}

		// Get the appropriate provider
		const provider = providerRegistry.get(providerType);
		if (!provider) {
			return Response.json({ error: `Provider '${providerType}' not available` }, { status: 500 });
		}

		// Validate config
		if (!provider.validateConfig(providerConfig)) {
			return Response.json(
				{ error: `Invalid configuration for provider '${providerType}'` },
				{ status: 400 }
			);
		}

		logger.info(
			{
				providerType,
				mediaType: data.mediaType,
				isTest
			},
			'[ExternalPreview API] Fetching external list'
		);

		// Fetch items from external source
		// For external lists, we pass empty string to show all content types
		// If mediaType is provided, use it; otherwise pass empty string for all types
		const result = await provider.fetchItems(providerConfig, data.mediaType ?? '');

		if (result.error) {
			return Response.json({ error: result.error }, { status: 400 });
		}

		logger.info(
			{
				totalCount: result.totalCount,
				failedCount: result.failedCount
			},
			'[ExternalPreview API] Fetched external items'
		);

		// For test endpoint, just return counts without resolving IDs
		if (isTest) {
			return Response.json({
				success: true,
				totalCount: result.totalCount,
				failedCount: result.failedCount
			});
		}

		// Resolve external items to TMDB items using concurrent batch processing
		const resolvedItems = [];
		const seenIds = new Set<number>();
		const failedItems: Array<{ imdbId?: string; title: string; year?: number; error?: string }> =
			[];
		let resolvedCount = 0;
		let failedCount = 0;
		let duplicatesRemoved = 0;

		// Determine resolution strategy based on mediaType
		// If no mediaType specified, try movie first, then TV as fallback
		const resolveMediaType = data.mediaType || 'movie';

		logger.info(
			{
				totalItems: result.items.length,
				mediaType: resolveMediaType
			},
			'[ExternalPreview API] Starting concurrent resolution'
		);

		// Use batch resolution with concurrency for much faster processing
		const resolutions = await externalIdResolver.resolveItemsBatch(
			result.items,
			resolveMediaType,
			10
		);

		// Process results and handle cross-type fallback for items without mediaType
		for (let i = 0; i < result.items.length; i++) {
			const item = result.items[i];
			let resolution = resolutions[i];

			// If no mediaType was specified and movie resolution failed, try TV
			if (!data.mediaType && !resolution.success && resolveMediaType === 'movie') {
				resolution = await externalIdResolver.resolveItem(item, 'tv');
			}

			if (resolution.success && resolution.tmdbId) {
				// Check for duplicates
				if (seenIds.has(resolution.tmdbId)) {
					duplicatesRemoved++;
					logger.debug(
						{
							tmdbId: resolution.tmdbId,
							title: resolution.title
						},
						'[ExternalPreview API] Duplicate item removed'
					);
					continue;
				}
				seenIds.add(resolution.tmdbId);

				resolvedItems.push({
					id: resolution.tmdbId,
					title: resolution.title,
					name: data.mediaType === 'tv' ? resolution.title : undefined,
					poster_path: item.posterPath ?? resolution.posterPath,
					vote_average: item.voteAverage ?? 0,
					release_date: item.year ? `${item.year}-01-01` : undefined,
					first_air_date: item.year ? `${item.year}-01-01` : undefined,
					overview: item.overview,
					inLibrary: false // Will be set below
				});
				resolvedCount++;
			} else {
				failedCount++;
				// Track failed items for debugging
				if (failedItems.length < 20) {
					failedItems.push({
						imdbId: item.imdbId,
						title: item.title,
						year: item.year,
						error: resolution.error
					});
				}
			}
		}

		// Log summary of failed items for debugging
		if (failedCount > 0) {
			logger.warn(
				{
					totalItems: result.items.length,
					resolvedCount,
					failedCount,
					duplicatesRemoved,
					failedItems: failedItems.slice(0, 10)
				},
				'[ExternalPreview API] Resolution summary'
			);
		}

		// Enrich with library status and filter blocked media
		const mediaTypeFilter = data.mediaType ?? 'all';
		const { results: filteredItems } = await contentFilterPipeline.apply(resolvedItems, {
			mediaType: mediaTypeFilter
		});

		// Apply preview cap and paginate at fixed 24 items (8x3 grid)
		const PREVIEW_PAGE_SIZE = 27;
		const cappedItems = filteredItems.slice(0, data.itemLimit);
		const page = data.page;
		const totalItems = cappedItems.length;
		const totalPages = Math.ceil(totalItems / PREVIEW_PAGE_SIZE);

		// Slice items for the requested page
		const startIndex = (page - 1) * PREVIEW_PAGE_SIZE;
		const endIndex = startIndex + PREVIEW_PAGE_SIZE;
		const paginatedItems = cappedItems.slice(startIndex, endIndex);

		logger.info(
			{
				page,
				itemsPerPage: PREVIEW_PAGE_SIZE,
				totalItems,
				totalPages,
				returnedItems: paginatedItems.length
			},
			'[ExternalPreview API] Returning paginated results'
		);

		return Response.json({
			items: paginatedItems,
			totalResults: totalItems,
			totalPages,
			unfilteredTotal: result.totalCount,
			resolvedCount,
			failedCount,
			duplicatesRemoved
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			logger.error({ issues: error.issues }, '[ExternalPreview API] Validation error');
			return Response.json({ error: 'Validation failed', details: error.issues }, { status: 400 });
		}
		logger.error('[ExternalPreview API] Error', error);
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};

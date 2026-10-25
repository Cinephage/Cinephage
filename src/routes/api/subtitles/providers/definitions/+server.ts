import type { RequestHandler } from './$types';
import { getSubtitleProviderFactory } from '#lib/server/subtitles/providers/SubtitleProviderFactory.js';
import { ensureProvidersRegistered } from '#lib/server/subtitles/providers/registry.js';

/**
 * GET /api/subtitles/providers/definitions
 * Get all available subtitle provider definitions.
 * These are the provider types that can be configured, not configured instances.
 */
export const GET: RequestHandler = async ({ url }) => {
	// Ensure providers are registered
	await ensureProvidersRegistered();

	const factory = getSubtitleProviderFactory();
	let definitions = factory.getDefinitions();

	// Apply optional filters
	const filterFree = url.searchParams.get('free') === 'true';
	const filterHash = url.searchParams.get('hash') === 'true';
	const searchQuery = url.searchParams.get('search')?.toLowerCase();

	if (filterFree) {
		definitions = definitions.filter((d) => !d.requiresApiKey);
	}

	if (filterHash) {
		definitions = definitions.filter((d) => d.supportsHashSearch);
	}

	if (searchQuery) {
		definitions = definitions.filter(
			(d) =>
				d.name.toLowerCase().includes(searchQuery) ||
				d.description.toLowerCase().includes(searchQuery) ||
				d.implementation.toLowerCase().includes(searchQuery)
		);
	}

	// Sort by name
	definitions.sort((a, b) => a.name.localeCompare(b.name));

	return Response.json({
		definitions,
		totalCount: definitions.length
	});
};

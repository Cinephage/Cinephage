import { tmdb } from '#lib/server/tmdb.js';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'DiscoverPersonPage', logDomain: 'system' });

export const load: PageServerLoad = async ({ params }) => {
	const id = parseInt(params.id);
	if (isNaN(id)) {
		throw error(400, 'Invalid person ID');
	}

	// Check if TMDB is configured
	const tmdbConfigured = await tmdb.isConfigured();
	if (!tmdbConfigured) {
		throw error(
			503,
			'TMDB API key not configured. Please configure your TMDB API key in Settings > Integrations.'
		);
	}

	try {
		// Fetch ONLY person details - no credits
		// This is ~5KB vs 150KB+ with combined_credits
		// Credits are loaded lazily by SectionRow via /api/tmdb/person/{id}/credits
		const person = await tmdb.getPersonBasic(id);

		// Handle null response (shouldn't happen since we checked config, but be safe)
		if (!person) {
			throw error(
				503,
				'TMDB API key not configured. Please configure your TMDB API key in Settings > Integrations.'
			);
		}

		return { person };
	} catch (e) {
		logger.error({ err: e, ...{ personId: id } }, 'Failed to fetch person');
		throw error(404, 'Person not found');
	}
};

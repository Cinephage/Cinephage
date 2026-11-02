import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { tmdb } from '#lib/server/tmdb.js';
import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import type { GlobalTmdbFilters } from '#lib/types/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';
import { TMDB } from '#lib/config/constants.js';

// TMDB content-filter settings (genre exclusions etc.), not disk scanning - 'system' fits better than 'scans'.
const logger = createChildLogger({ module: 'LibraryFiltersSettingsPage', logDomain: 'system' });

// Language/region localization is edited in the Library > Languages tab
// (/settings/library/languages); this loader only supplies the remaining
// content filters. Stored language/region values still ride along in `filters`
// so the PUT payload keeps its shape (the filters API mirrors them, harmless).
export const load: PageServerLoad = async () => {
	// Fetch current settings
	const settingsData = await db.query.settings.findFirst({
		where: eq(settings.key, 'global_filters')
	});

	let currentFilters: GlobalTmdbFilters = {
		include_adult: false,
		min_vote_average: 0,
		min_vote_count: 0,
		language: `en-${TMDB.DEFAULT_REGION}`,
		region: TMDB.DEFAULT_REGION,
		excluded_genre_ids: []
	};

	if (settingsData) {
		try {
			currentFilters = { ...currentFilters, ...JSON.parse(settingsData.value) };
		} catch (e) {
			logger.error({ err: e }, 'Failed to parse global_filters');
		}
	}

	// Check if TMDB is configured
	const tmdbConfigured = await tmdb.isConfigured();

	// Fetch Genres (only if TMDB is configured)
	let genres: { id: number; name: string }[] = [];

	if (tmdbConfigured) {
		try {
			const [movieGenres, tvGenres] = await Promise.all([
				tmdb.fetch('/genre/movie/list') as Promise<{
					genres: { id: number; name: string }[];
				} | null>,
				tmdb.fetch('/genre/tv/list') as Promise<{ genres: { id: number; name: string }[] } | null>
			]);

			if (movieGenres && tvGenres) {
				const genreMap = new Map<number, string>();
				movieGenres.genres.forEach((g) => genreMap.set(g.id, g.name));
				tvGenres.genres.forEach((g) => genreMap.set(g.id, g.name));

				genres = Array.from(genreMap.entries())
					.map(([id, name]) => ({ id, name }))
					.sort((a, b) => a.name.localeCompare(b.name));
			}
		} catch (e) {
			logger.error({ err: e }, 'Failed to fetch TMDB configuration');
		}
	}

	return {
		filters: currentFilters,
		genres,
		tmdbConfigured
	};
};

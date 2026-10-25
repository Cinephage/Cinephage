import type {
	TmdbConfiguration,
	MovieDetails,
	TVShowDetails,
	Season,
	Collection,
	PersonDetails
} from './types/tmdb';

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'tmdb', logDomain: 'system' });

// Cache both the result AND the pending promise to prevent duplicate requests
let configCache: TmdbConfiguration | null = null;
let configPromise: Promise<TmdbConfiguration> | null = null;

/**
 * Safely parse JSON from response, returning empty object if parsing fails.
 * Logs a warning when JSON parsing fails to aid debugging.
 */
async function safeParseErrorJson(
	res: Response,
	context: string
): Promise<Record<string, unknown>> {
	try {
		return await res.json();
	} catch {
		if (typeof window === 'undefined') {
			logger.warn(
				{ component: 'tmdb', context, status: res.status },
				'[TMDB] Failed to parse error response JSON'
			);
		}
		return {};
	}
}

export const tmdb = {
	async get<T>(endpoint: string, customFetch = fetch): Promise<T> {
		const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
		const res = await customFetch(`/api/tmdb${path}`);
		if (!res.ok) {
			const error = await safeParseErrorJson(res, `GET ${path}`);
			throw new Error((error.error as string) || `TMDB Request Failed (${res.status})`);
		}
		return res.json();
	},
	async configuration(customFetch = fetch): Promise<TmdbConfiguration> {
		// Return cached result if available
		if (configCache) return configCache;

		// If a request is already in flight, wait for it
		if (configPromise) return configPromise;

		// Start new request and cache the promise
		configPromise = this.get<TmdbConfiguration>('/configuration', customFetch)
			.then((config) => {
				configCache = config;
				return config;
			})
			.catch((error) => {
				// Clear promise on error so retry is possible
				configPromise = null;
				throw error;
			});

		return configPromise;
	},
	async getMovie(id: number, customFetch = fetch): Promise<MovieDetails> {
		return this.get<MovieDetails>(
			`/movie/${id}?append_to_response=credits,videos,images,recommendations,similar`,
			customFetch
		);
	},
	async getTVShow(id: number, customFetch = fetch): Promise<TVShowDetails> {
		return this.get<TVShowDetails>(
			`/tv/${id}?append_to_response=credits,videos,images,recommendations,similar`,
			customFetch
		);
	},
	async getSeason(tvId: number, seasonNumber: number, customFetch = fetch): Promise<Season> {
		return this.get<Season>(`/tv/${tvId}/season/${seasonNumber}`, customFetch);
	},
	async getCollection(id: number, customFetch = fetch): Promise<Collection> {
		return this.get<Collection>(`/collection/${id}`, customFetch);
	},
	async getPerson(id: number, customFetch = fetch): Promise<PersonDetails> {
		return this.get<PersonDetails>(
			`/person/${id}?append_to_response=combined_credits,external_ids`,
			customFetch
		);
	}
};

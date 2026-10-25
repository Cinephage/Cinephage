import { apiGet } from './client.js';

/**
 * A TMDB discover/search result row as enriched by the server (poster/backdrop
 * paths, release dates, library flags where applicable). TMDB rows carry more
 * fields than any consumer reads; the index signature keeps this honest.
 */
export interface DiscoverResult {
	id: number;
	media_type?: string;
	title?: string;
	name?: string;
	poster_path?: string | null;
	backdrop_path?: string | null;
	release_date?: string | null;
	first_air_date?: string | null;
	vote_average?: number;
	overview?: string;
	[key: string]: unknown;
}

/** Discover/search endpoints return a bare { results, pagination } object. */
export interface DiscoverResponse {
	results: DiscoverResult[];
	pagination: {
		page: number;
		total_pages: number;
		total_results: number;
	};
}

export async function getDiscover(params: Record<string, string>): Promise<DiscoverResponse> {
	const response = await apiGet('/api/discover', params);
	return response as unknown as DiscoverResponse;
}

export async function getDiscoverUnfiltered(
	params: Record<string, string>
): Promise<DiscoverResponse> {
	const response = await apiGet('/api/discover', { ...params, skip_blocked: 'true' });
	return response as unknown as DiscoverResponse;
}

export async function searchTmdb(params: Record<string, string>): Promise<DiscoverResponse> {
	const response = await apiGet('/api/discover/search', params);
	return response as unknown as DiscoverResponse;
}

/**
 * Generic TMDB proxy — the shape depends entirely on the proxied path
 * (movie details, collections, ...). Consumers narrow to what they requested.
 */
export async function getTmdb(path: string, params?: Record<string, string>) {
	return apiGet<Record<string, unknown>>(`/api/tmdb/${path}`, params);
}

/** Person combined credits (cast/crew arrays keyed by media type). */
export async function getPersonCredits(personId: number, params?: Record<string, string>) {
	return apiGet<Record<string, unknown>>(`/api/tmdb/person/${personId}/credits`, params);
}

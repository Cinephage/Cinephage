import { apiGet, apiPut } from './client.js';
import type { CalendarPreferences } from '#lib/validation/schemas.js';

/**
 * Client-safe mirrors of the calendar payload shapes. Source of truth:
 * src/lib/server/calendar/queries.ts (server-only; keep in sync).
 */
export interface CalendarMovieItem {
	tmdbId: number;
	title: string;
	posterPath: string | null;
	releaseDate: string;
	inLibrary: boolean;
	movieId?: string;
}

export interface CalendarEpisodeItem {
	episodeId: string;
	title: string | null;
	seasonNumber: number;
	episodeNumber: number;
	airDate: string | null;
	seriesId: string;
	seriesTitle: string;
	seriesPosterPath: string | null;
}

export interface CalendarDay {
	date: string;
	movies: CalendarMovieItem[];
	episodes: CalendarEpisodeItem[];
}

export interface UpcomingItem {
	type: 'movie' | 'episode';
	date: string;
	title: string;
	posterPath: string | null;
	subtitle?: string;
	tmdbId?: number;
	movieId?: string;
	seriesId?: string;
	episodeId?: string;
}

export async function getCalendar(
	month?: string,
	type?: 'all' | 'movies' | 'episodes',
	libraryOnly?: boolean,
	minRating?: number,
	genreIds?: number[],
	excludeAdult?: boolean,
	certifications?: string[]
): Promise<CalendarDay[]> {
	const params: Record<string, string> = {};
	if (month) params.month = month;
	if (type && type !== 'all') params.type = type;
	if (libraryOnly) params.libraryOnly = 'true';
	if (minRating && minRating > 0) params.minRating = String(minRating);
	if (genreIds && genreIds.length > 0) params.genreIds = genreIds.join(',');
	if (excludeAdult) params.excludeAdult = 'true';
	if (certifications && certifications.length > 0) params.certifications = certifications.join(',');
	// The endpoint returns a bare array, not the success/error envelope.
	const response = await apiGet('/api/calendar', params);
	return response as unknown as CalendarDay[];
}

export async function getUpcoming(): Promise<UpcomingItem[]> {
	// The endpoint returns a bare array, not the success/error envelope.
	const response = await apiGet('/api/calendar/upcoming');
	return response as unknown as UpcomingItem[];
}

export async function getCalendarPreferences() {
	return apiGet<{ value: CalendarPreferences }>('/api/user/preferences/calendar');
}

export async function updateCalendarPreferences(prefs: CalendarPreferences) {
	return apiPut<{ value: CalendarPreferences }>('/api/user/preferences/calendar', { value: prefs });
}

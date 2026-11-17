/**
 * Deep links — the one place that turns an entity into an absolute app URL.
 *
 * Notifications are useless without a way back into the app, and a link is
 * only worth sending when the instance knows its own public address (the
 * System → General "External URL"). Without that setting the message keeps
 * its text and simply carries no link, rather than a localhost URL that
 * nobody's phone can open.
 */

import { getSystemSettingsService } from '#lib/server/settings/SystemSettingsService.js';

/** Normalised public base URL, or null when the instance has none configured. */
export async function getPublicBaseUrl(): Promise<string | null> {
	const raw = await getSystemSettingsService().getExternalUrl();
	if (!raw) return null;
	const trimmed = raw.trim().replace(/\/+$/, '');
	if (!trimmed) return null;
	return /^https?:\/\/[^/\s]+/i.test(trimmed) ? trimmed : null;
}

/** App path for a library entity. */
export function libraryPath(mediaType: 'movie' | 'series', id: string): string {
	return mediaType === 'movie' ? `/library/movie/${id}` : `/library/tv/${id}`;
}

/** Wraps a path in the public base URL, or returns null when there is none. */
export async function buildLink(path: string): Promise<string | null> {
	const base = await getPublicBaseUrl();
	return base ? `${base}${path}` : null;
}

/** TMDB poster path → absolute image URL (posters are small enough to link). */
export function tmdbPosterUrl(posterPath: string | null | undefined): string | null {
	if (!posterPath) return null;
	const path = posterPath.startsWith('/') ? posterPath : `/${posterPath}`;
	return `https://image.tmdb.org/t/p/w500${path}`;
}

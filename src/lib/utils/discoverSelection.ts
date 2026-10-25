/**
 * Shared helpers for the discover page's multi-select ("add several items at
 * once") flow. Kept pure and client-safe so both the page and tests can use
 * them without Svelte state machinery.
 */
import type { TmdbMediaItem } from '#lib/types/tmdb.js';
import {
	getMediaDate,
	getMediaPoster,
	getMediaTitle,
	getMediaTypeLabel
} from '#lib/types/tmdb-guards.js';

export interface DiscoverSelectionEntry {
	mediaType: 'movie' | 'tv';
	tmdbId: number;
	title: string;
	year?: number;
	posterPath: string | null;
}

/**
 * Stable identity for a selectable discover card. Returns null for items that
 * cannot be added to the library (people, or unknown shapes).
 */
export function discoverSelectionKey(item: TmdbMediaItem): string | null {
	const label = getMediaTypeLabel(item);
	if (label === 'Movie') return `movie-${item.id}`;
	if (label === 'TV') return `tv-${item.id}`;
	return null;
}

/**
 * The data the bulk-add modal needs for one selected card.
 */
export function toDiscoverSelectionEntry(item: TmdbMediaItem): DiscoverSelectionEntry | null {
	const key = discoverSelectionKey(item);
	if (!key) return null;

	const date = getMediaDate(item);
	const parsedYear = date ? new Date(date).getFullYear() : NaN;

	return {
		mediaType: key.startsWith('movie') ? 'movie' : 'tv',
		tmdbId: item.id,
		title: getMediaTitle(item),
		year: Number.isFinite(parsedYear) ? parsedYear : undefined,
		posterPath: getMediaPoster(item)
	};
}

/**
 * Split a list into fixed-size chunks. Bulk endpoints cap their array length
 * (50), so larger selections are added in sequential batches.
 */
export function chunkItems<T>(items: T[], size: number): T[][] {
	if (size < 1) return items.length > 0 ? [items] : [];
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

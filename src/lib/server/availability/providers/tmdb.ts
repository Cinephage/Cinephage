import { tmdb } from '#lib/server/tmdb.js';
import type { ReleaseDate, ReleaseDatesResponse } from '#lib/types/tmdb.js';
import type { NewReleaseEvent, ReleaseKind } from '../types.js';
import type { ReleaseProvider, ReleaseProviderFetchOptions, ReleaseProviderRef } from './types.js';

/** TMDB release `type` → domain kind. 2 (limited) is still a theatrical window. */
const TMDB_TYPE_TO_KIND: Record<number, ReleaseKind> = {
	1: 'premiere',
	2: 'theatrical',
	3: 'theatrical',
	4: 'digital',
	5: 'physical',
	6: 'tv'
};

/**
 * Release windows from TMDB.
 *
 * Emits one event per TMDB release entry rather than collapsing to one date per
 * type: re-releases, regional premieres and platform notes are all kept, and
 * consumers pick the earliest relevant one instead of losing the detail here.
 */
export class TmdbReleaseProvider implements ReleaseProvider {
	id = 'tmdb' as const;
	supportedMediaTypes = ['movie'] as const;
	authority = ['premiere', 'theatrical', 'digital', 'physical', 'tv'] as const;

	async isConfigured(): Promise<boolean> {
		return tmdb.isConfigured();
	}

	async fetch(
		ref: ReleaseProviderRef,
		options: ReleaseProviderFetchOptions
	): Promise<NewReleaseEvent[]> {
		if (ref.mediaType !== 'movie' || !ref.tmdbId) return [];

		const info = await tmdb.getMovieReleaseInfo(ref.tmdbId);
		return toEventsFromReleaseDates(ref.mediaId, info?.release_dates ?? null, options.region);
	}
}

/**
 * Pure mapping, shared by the provider (which fetches) and `MetadataRefreshTask`
 * (which already holds the payload from its own `getMovie` call, so re-fetching
 * release dates there would double the request count).
 */
export function toEventsFromReleaseDates(
	mediaId: string,
	response: ReleaseDatesResponse | null,
	region: string
): NewReleaseEvent[] {
	const countries = response?.results ?? [];
	const country =
		countries.find((entry) => entry.iso_3166_1 === region) ??
		countries.find((entry) => entry.iso_3166_1 === 'US') ??
		countries[0];

	if (!country) return [];

	const events: NewReleaseEvent[] = [];
	for (const entry of country.release_dates ?? []) {
		const kind = TMDB_TYPE_TO_KIND[entry.type];
		if (!kind) continue;
		const releaseDate = normalizeDate(entry.release_date);
		if (!releaseDate) continue;

		events.push({
			mediaType: 'movie',
			mediaId,
			kind,
			region: country.iso_3166_1,
			platform: describeEntry(entry),
			releaseDate,
			releaseTime: null,
			timezone: null,
			source: 'tmdb',
			sourceId: `${country.iso_3166_1}:${entry.type}:${releaseDate}`,
			confidence: entry.type === 3 || entry.type === 4 ? 'confirmed' : 'predicted'
		});
	}

	return events;
}

/** TMDB dates are ISO-8601 with a time component; the domain stores `YYYY-MM-DD`. */
function normalizeDate(value: string | null | undefined): string | null {
	if (!value) return null;
	const date = value.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/** `note` carries the useful platform hint ('Paramount+', 'Blu-ray / DVD'). */
function describeEntry(entry: ReleaseDate): string | null {
	const note = entry.note?.trim();
	return note ? note : null;
}

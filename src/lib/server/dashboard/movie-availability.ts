import { getAvailabilityService } from '#lib/server/availability/AvailabilityService.js';
import type { AvailabilityLevel } from '#lib/server/availability/types.js';

/**
 * Dashboard availability for movies that are missing a file.
 *
 * Reads release events in one bulk query per page. This used to fan out to
 * TMDB with an unbounded `Promise.all` on every dashboard render — one request
 * per current-year movie — and then re-derive the level locally.
 */

export interface MovieAvailabilityRow {
	id: string;
	tmdbId: number | null;
	year: number | null;
	added: string | null;
	monitored: boolean | null;
	minimumAvailability?: string | null;
}

export interface MissingMovieAvailabilityCounts {
	monitoredReleasedMissing: number;
	monitoredInCinemas: number;
	monitoredAnnounced: number;
	monitoredUnreleased: number;
	unmonitoredMissing: number;
}

/**
 * Titles TMDB has no release dates for at all still need an answer. Fall back to
 * the year heuristic rather than calling a title with no dates "announced".
 */
function fallbackLevel(year: number | null): AvailabilityLevel {
	const currentYear = new Date().getFullYear();
	if (year !== null && year < currentYear) return 'released';
	return 'announced';
}

function resolveLevel(level: AvailabilityLevel | undefined, year: number | null): AvailabilityLevel {
	return level ?? fallbackLevel(year);
}

export async function computeMissingMovieAvailabilityCounts(
	movies: MovieAvailabilityRow[]
): Promise<MissingMovieAvailabilityCounts> {
	let monitoredReleasedMissing = 0;
	let monitoredInCinemas = 0;
	let monitoredAnnounced = 0;
	let monitoredUnreleased = 0;
	let unmonitoredMissing = 0;

	const availabilityById = await getAvailabilityService().getAvailabilityMap(
		movies.map((movie) => ({ id: movie.id, minimumAvailability: movie.minimumAvailability }))
	);

	for (const movie of movies) {
		if (!movie.monitored) {
			unmonitoredMissing++;
			continue;
		}

		const level = resolveLevel(availabilityById.get(movie.id)?.level, movie.year);

		if (level === 'released') {
			monitoredReleasedMissing++;
		} else if (level === 'inCinemas') {
			monitoredInCinemas++;
			monitoredUnreleased++;
		} else {
			monitoredAnnounced++;
			monitoredUnreleased++;
		}
	}

	return {
		monitoredReleasedMissing,
		monitoredInCinemas,
		monitoredAnnounced,
		monitoredUnreleased,
		unmonitoredMissing
	};
}

export async function enrichMoviesWithAvailability<T extends MovieAvailabilityRow>(
	movies: T[]
): Promise<Array<T & { availability: AvailabilityLevel; isReleased: boolean }>> {
	const availabilityById = await getAvailabilityService().getAvailabilityMap(
		movies.map((movie) => ({ id: movie.id, minimumAvailability: movie.minimumAvailability }))
	);

	return movies.map((movie) => {
		const availability = resolveLevel(availabilityById.get(movie.id)?.level, movie.year);
		return {
			...movie,
			availability,
			isReleased: availability === 'released'
		};
	});
}

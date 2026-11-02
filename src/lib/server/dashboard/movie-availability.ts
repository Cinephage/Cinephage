import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import { tmdb, type MovieReleaseInfo } from '#lib/server/tmdb.js';
import {
	getMovieAvailabilityLevel,
	type MovieAvailabilityLevel
} from '#lib/utils/movieAvailability.js';

interface MovieAvailabilityRow {
	tmdbId: number;
	year: number | null;
	added: string | null;
	monitored: boolean | null;
	downloadReleaseDate?: string | null;
	downloadReleaseType?: string | null;
	digitalReleaseDate?: string | null;
	physicalReleaseDate?: string | null;
}

export interface MissingMovieAvailabilityCounts {
	monitoredReleasedMissing: number;
	monitoredInCinemas: number;
	monitoredAnnounced: number;
	monitoredUnreleased: number;
	unmonitoredMissing: number;
}

function flattenReleaseDates(releaseInfo: MovieReleaseInfo | null) {
	if (!releaseInfo?.release_dates?.results) return undefined;
	return releaseInfo.release_dates.results.flatMap((c) =>
		c.release_dates.map((rd) => ({
			type: rd.type,
			release_date: rd.release_date
		}))
	);
}

async function getReleaseInfoMap(tmdbIds: number[]): Promise<Map<number, MovieReleaseInfo | null>> {
	const uniqueTmdbIds = [...new Set(tmdbIds)];
	if (uniqueTmdbIds.length === 0) return new Map();

	const releaseInfoEntries = await Promise.all(
		uniqueTmdbIds.map(async (tmdbId) => {
			try {
				const info = await tmdb.getMovieReleaseInfo(tmdbId);
				return [tmdbId, info] as const;
			} catch (error) {
				logger.warn(
					{
						tmdbId,
						error: error instanceof Error ? error.message : String(error)
					},
					'[Dashboard] Failed to fetch TMDB movie release info'
				);
				return [tmdbId, null] as const;
			}
		})
	);

	return new Map(releaseInfoEntries);
}

export async function computeMissingMovieAvailabilityCounts(
	movies: MovieAvailabilityRow[]
): Promise<MissingMovieAvailabilityCounts> {
	let monitoredReleasedMissing = 0;
	let monitoredInCinemas = 0;
	let monitoredAnnounced = 0;
	let monitoredUnreleased = 0;
	let unmonitoredMissing = 0;

	const now = new Date();
	const currentYear = now.getFullYear();

	// Only current-year/unknown-year monitored movies are ambiguous enough to require TMDB status/date.
	const tmdbLookupIds = movies
		.filter(
			(movie) => Boolean(movie.monitored) && (movie.year === currentYear || movie.year === null)
		)
		.map((movie) => movie.tmdbId);
	const releaseInfoByTmdbId = await getReleaseInfoMap(tmdbLookupIds);

	for (const movie of movies) {
		if (!movie.monitored) {
			unmonitoredMissing++;
			continue;
		}

		// Fast-path for non-ambiguous years.
		if (movie.year !== null && movie.year < currentYear) {
			monitoredReleasedMissing++;
			continue;
		}
		if (movie.year !== null && movie.year > currentYear) {
			monitoredAnnounced++;
			monitoredUnreleased++;
			continue;
		}

		const releaseInfo = releaseInfoByTmdbId.get(movie.tmdbId);
		const releaseDates = flattenReleaseDates(releaseInfo ?? null);

		if (!releaseDates) {
			const fallbackDate =
				movie.digitalReleaseDate ?? movie.physicalReleaseDate ?? movie.downloadReleaseDate;
			if (fallbackDate) {
				const ts = new Date(fallbackDate).getTime();
				if (!Number.isNaN(ts) && ts <= now.getTime()) {
					monitoredReleasedMissing++;
					continue;
				}
			}
		}

		const availability = getMovieAvailabilityLevel(
			{
				year: movie.year,
				added: movie.added,
				tmdbStatus: releaseInfo?.status,
				releaseDate: releaseInfo?.release_date,
				releaseDates,
				digitalReleaseDate: movie.digitalReleaseDate,
				physicalReleaseDate: movie.physicalReleaseDate
			},
			now
		);

		if (availability === 'released') {
			monitoredReleasedMissing++;
		} else if (availability === 'inCinemas') {
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
): Promise<Array<T & { availability: MovieAvailabilityLevel; isReleased: boolean }>> {
	const now = new Date();
	const currentYear = now.getFullYear();

	// Only current-year or unknown-year movies need TMDB data to resolve availability.
	// Past-year movies are deterministically "released" and future-year are "announced"
	// without any external API call.
	const ambiguousTmdbIds = movies
		.filter((movie) => movie.year === currentYear || movie.year === null)
		.map((movie) => movie.tmdbId);
	const releaseInfoByTmdbId = await getReleaseInfoMap(ambiguousTmdbIds);

	return movies.map((movie) => {
		const releaseInfo = releaseInfoByTmdbId.get(movie.tmdbId);
		const releaseDates = flattenReleaseDates(releaseInfo ?? null);

		const availability = getMovieAvailabilityLevel(
			{
				year: movie.year,
				added: movie.added,
				tmdbStatus: releaseInfo?.status,
				releaseDate: releaseInfo?.release_date,
				releaseDates,
				digitalReleaseDate: movie.digitalReleaseDate,
				physicalReleaseDate: movie.physicalReleaseDate
			},
			now
		);

		return {
			...movie,
			availability,
			isReleased: availability === 'released'
		};
	});
}

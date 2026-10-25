/**
 * AvailabilitySpecification
 *
 * Checks if a movie has reached its minimum availability status before
 * automated searching/grabbing. This prevents downloading pre-release
 * content that might be fake or low quality.
 *
 * Availability levels (in order of release):
 * - 'announced': Movie has been announced (very early, often no releases)
 * - 'inCinemas': Movie is currently in theaters
 * - 'released': Movie is released on digital/physical media
 *
 * The specification accepts if the movie's current state meets or exceeds
 * the configured minimum availability threshold.
 */

import type {
	IMonitoringSpecification,
	MovieContext,
	SpecificationResult,
	ReleaseCandidate
} from './types.js';
import { reject, accept } from './types.js';
import { tmdb, type MovieReleaseInfo } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });
import { getMovieAvailabilityLevel } from '#lib/utils/movieAvailability.js';

/**
 * Availability levels in order of "availability"
 * Higher index = more available
 */
const AVAILABILITY_ORDER = ['announced', 'inCinemas', 'released'] as const;
type AvailabilityLevel = (typeof AVAILABILITY_ORDER)[number];

/**
 * Extended RejectionReason for availability
 */
export const AvailabilityRejectionReason = {
	NOT_YET_AVAILABLE: 'not_yet_available',
	UNKNOWN_AVAILABILITY: 'unknown_availability'
} as const;

/**
 * Check if a movie meets minimum availability requirements
 */
export class MovieAvailabilitySpecification implements IMonitoringSpecification<MovieContext> {
	private releaseInfoCache = new Map<number, MovieReleaseInfo | null>();

	async isSatisfied(
		context: MovieContext,
		_release?: ReleaseCandidate
	): Promise<SpecificationResult> {
		const { movie } = context;

		const minimumAvailability = (movie.minimumAvailability as AvailabilityLevel) || 'released';

		if (minimumAvailability === 'announced') {
			return accept();
		}

		const hasStoredDates =
			movie.digitalReleaseDate ||
			movie.physicalReleaseDate ||
			movie.downloadReleaseDate ||
			movie.releaseDate;

		if (hasStoredDates) {
			const { isMovieAvailableForSearch } = await import('#lib/utils/movieAvailability.js');
			const available = isMovieAvailableForSearch({
				minimumAvailability,
				releaseDate: movie.releaseDate ?? null,
				digitalReleaseDate: movie.digitalReleaseDate ?? null,
				physicalReleaseDate: movie.physicalReleaseDate ?? null,
				downloadReleaseDate: movie.downloadReleaseDate ?? null,
				availabilityDelay: movie.availabilityDelay ?? 0
			});

			if (available) return accept();

			return reject(
				`${AvailabilityRejectionReason.NOT_YET_AVAILABLE}: requires ${minimumAvailability}`
			);
		}

		const currentAvailability = await this.getCurrentAvailability(movie);
		const currentIndex = AVAILABILITY_ORDER.indexOf(currentAvailability);
		const minimumIndex = AVAILABILITY_ORDER.indexOf(minimumAvailability);

		if (currentIndex === -1) {
			return reject(AvailabilityRejectionReason.UNKNOWN_AVAILABILITY);
		}

		if (currentIndex < minimumIndex) {
			return reject(
				`${AvailabilityRejectionReason.NOT_YET_AVAILABLE}: movie is ${currentAvailability}, requires ${minimumAvailability}`
			);
		}

		return accept();
	}

	private async getCurrentAvailability(movie: MovieContext['movie']): Promise<AvailabilityLevel> {
		const releaseInfo = await this.getReleaseInfo(movie.tmdbId);

		// Region-scope the release dates (fall back to all countries) so availability
		// matches what the rest of the app shows for the user's configured region.
		const region = (await tmdb.getRegion()).toUpperCase();
		const allResults = releaseInfo?.release_dates?.results;
		const regionResults = allResults?.filter((c) => c.iso_3166_1.toUpperCase() === region);
		const source = regionResults && regionResults.length > 0 ? regionResults : allResults;

		const releaseDates = source?.flatMap((c) =>
			c.release_dates.map((rd) => ({
				type: rd.type,
				release_date: rd.release_date
			}))
		);

		return getMovieAvailabilityLevel({
			year: movie.year,
			added: movie.added,
			tmdbStatus: releaseInfo?.status,
			releaseDate: releaseInfo?.release_date,
			releaseDates
		});
	}

	private async getReleaseInfo(tmdbId: number): Promise<MovieReleaseInfo | null> {
		if (this.releaseInfoCache.has(tmdbId)) {
			return this.releaseInfoCache.get(tmdbId) ?? null;
		}

		try {
			const releaseInfo = await tmdb.getMovieReleaseInfo(tmdbId);
			this.releaseInfoCache.set(tmdbId, releaseInfo);
			return releaseInfo;
		} catch (error) {
			logger.warn(
				{
					tmdbId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[MovieAvailabilitySpecification] Failed to fetch TMDB release info'
			);
			this.releaseInfoCache.set(tmdbId, null);
			return null;
		}
	}
}

/**
 * Convenience function to check if a movie is available
 */
export async function isMovieAvailable(
	context: MovieContext,
	minimumAvailability?: AvailabilityLevel
): Promise<boolean> {
	// Override the context's minimum availability if specified
	const contextWithOverride = minimumAvailability
		? {
				...context,
				movie: { ...context.movie, minimumAvailability }
			}
		: context;

	const spec = new MovieAvailabilitySpecification();
	const result = await spec.isSatisfied(contextWithOverride);
	return result.accepted;
}

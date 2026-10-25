import type { DecisionStage, StageResult } from '../../types.js';
import type { SearchEligibilityContext } from './types.js';
import { isMovieAvailableForSearch } from '#lib/utils/movieAvailability.js';
import { tmdb } from '#lib/server/tmdb.js';
import { getMovieAvailabilityLevel } from '#lib/utils/movieAvailability.js';

const AVAILABILITY_ORDER = ['announced', 'inCinemas', 'released'] as const;
type AvailabilityLevel = (typeof AVAILABILITY_ORDER)[number];

export class AvailabilityStage implements DecisionStage<SearchEligibilityContext> {
	name = 'availability';

	isEnabled(ctx: SearchEligibilityContext): boolean {
		if (ctx.options.forceSearch) return false;
		return !ctx.episode;
	}

	async evaluate(ctx: SearchEligibilityContext): Promise<StageResult> {
		const { media } = ctx;
		const minimumAvailability = (media.minimumAvailability as AvailabilityLevel) || 'released';

		if (minimumAvailability === 'announced') {
			return { accepted: true };
		}

		const hasStoredDates =
			media.digitalReleaseDate ||
			media.physicalReleaseDate ||
			media.downloadReleaseDate ||
			media.releaseDate;

		if (hasStoredDates) {
			const available = isMovieAvailableForSearch({
				minimumAvailability,
				releaseDate: media.releaseDate ?? null,
				digitalReleaseDate: media.digitalReleaseDate ?? null,
				physicalReleaseDate: media.physicalReleaseDate ?? null,
				downloadReleaseDate: media.downloadReleaseDate ?? null,
				availabilityDelay: media.availabilityDelay ?? 0
			});

			if (available) return { accepted: true };

			return {
				accepted: false,
				reason: `Not yet available: requires ${minimumAvailability}`
			};
		}

		try {
			const releaseInfo = await tmdb.getMovieReleaseInfo(media.tmdbId);
			// Region-scope (fall back to all countries) so it matches the displayed region.
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

			const currentAvailability = getMovieAvailabilityLevel({
				year: media.year,
				added: media.added,
				tmdbStatus: releaseInfo?.status,
				releaseDate: releaseInfo?.release_date,
				releaseDates
			});

			const currentIndex = AVAILABILITY_ORDER.indexOf(currentAvailability);
			const minimumIndex = AVAILABILITY_ORDER.indexOf(minimumAvailability);

			if (currentIndex === -1) {
				return { accepted: false, reason: 'Unknown availability status' };
			}

			if (currentIndex < minimumIndex) {
				return {
					accepted: false,
					reason: `Not yet available: movie is ${currentAvailability}, requires ${minimumAvailability}`
				};
			}

			return { accepted: true };
		} catch {
			return { accepted: true };
		}
	}
}

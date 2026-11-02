import { tmdb } from '#lib/server/tmdb.js';
import { extractReleaseDates } from '#lib/utils/extractReleaseDates.js';
import { TMDB } from '#lib/config/constants.js';

export async function enrichWithReleaseDates<T extends { id: number; media_type?: string }>(
	items: T[],
	region?: string
): Promise<T[]> {
	const effectiveRegion = region || TMDB.DEFAULT_REGION;

	const moviesToEnrich = items.filter((item) => {
		if (item.media_type && item.media_type !== 'movie') return false;
		const rec = item as Record<string, unknown>;
		return !rec.digitalReleaseDate && !rec.physicalReleaseDate;
	});

	if (moviesToEnrich.length === 0) return items;

	const releaseDateMap = new Map<
		number,
		{
			theatricalDate: string | null;
			digitalReleaseDate: string | null;
			physicalReleaseDate: string | null;
			tvReleaseDate: string | null;
			status: string | null;
		}
	>();

	await Promise.all(
		moviesToEnrich.map(async (movie) => {
			try {
				const releaseInfo = await tmdb.getMovieReleaseInfo(movie.id);
				if (releaseInfo?.release_dates) {
					releaseDateMap.set(movie.id, {
						...extractReleaseDates(releaseInfo.release_dates, effectiveRegion),
						status: releaseInfo.status ?? null
					});
				}
			} catch {
				// Missing release dates aren't critical
			}
		})
	);

	if (releaseDateMap.size === 0) return items;

	return items.map((item) => {
		const dates = releaseDateMap.get(item.id);
		if (!dates) return item;
		const rec = item as Record<string, unknown>;
		return {
			...item,
			releaseDate: dates.theatricalDate ?? rec.release_date ?? null,
			digitalReleaseDate: dates.digitalReleaseDate,
			physicalReleaseDate: dates.physicalReleaseDate,
			tvReleaseDate: dates.tvReleaseDate,
			tmdbStatus: dates.status
		} as T;
	});
}

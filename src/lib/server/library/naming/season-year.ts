/**
 * The year a season first aired.
 *
 * `{Year}` is the series premiere year, so every season folder of a long-running
 * show renders the same year. The season's own air date is already stored
 * (`seasons.air_date`, from TMDB's `seasons[].air_date`), it just had no token.
 *
 * Resolution order, cheapest first:
 *   1. `seasons.air_date`
 *   2. the season's earliest `episodes.air_date`
 *   3. the air date the caller already holds (import planning)
 *   4. nothing, so optional-group syntax `{[...]}` still works
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { episodes, seasons } from '#lib/server/db/schema.js';

/** Four-digit year of a `YYYY-MM-DD` (or ISO) date, or undefined. */
export function yearOfDate(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^(\d{4})-/.exec(value);
	if (match) return Number(match[1]);
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.getUTCFullYear();
}

/**
 * Year from episodes already loaded by the caller - no query. Used by the
 * rename preview, which holds every episode of the series anyway.
 */
export function seasonYearFromEpisodes(
	list: Iterable<{ seasonNumber: number | null; airDate: string | null }>,
	seasonNumber: number
): number | undefined {
	let earliest: string | undefined;
	for (const episode of list) {
		if (episode.seasonNumber !== seasonNumber || !episode.airDate) continue;
		if (earliest === undefined || episode.airDate < earliest) earliest = episode.airDate;
	}
	return yearOfDate(earliest);
}

export async function resolveSeasonYear(input: {
	seriesId?: string | null;
	seasonNumber?: number | null;
	/** Air date the caller already holds, used when the database has nothing. */
	fallbackAirDate?: string | null;
}): Promise<number | undefined> {
	const { seriesId, seasonNumber } = input;

	if (seriesId && seasonNumber !== undefined && seasonNumber !== null) {
		const [season] = await db
			.select({ airDate: seasons.airDate })
			.from(seasons)
			.where(and(eq(seasons.seriesId, seriesId), eq(seasons.seasonNumber, seasonNumber)))
			.limit(1);
		const fromSeason = yearOfDate(season?.airDate);
		if (fromSeason !== undefined) return fromSeason;

		const [first] = await db
			.select({ airDate: episodes.airDate })
			.from(episodes)
			.where(
				and(
					eq(episodes.seriesId, seriesId),
					eq(episodes.seasonNumber, seasonNumber),
					isNotNull(episodes.airDate)
				)
			)
			.orderBy(episodes.airDate)
			.limit(1);
		const fromEpisodes = yearOfDate(first?.airDate);
		if (fromEpisodes !== undefined) return fromEpisodes;
	}

	return yearOfDate(input.fallbackAirDate);
}

/**
 * "Aired" is one rule: an episode with a non-empty air date on or before today.
 *
 * Search, monitoring and the calendar all need it, and each had grown its own
 * copy of the comparison. The copies drift — one compares a Date, another a
 * string, another filters in SQL. This module is the single definition, plus
 * the two season queries built on it.
 */

import { and, eq, lte } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { episodes } from '#lib/server/db/schema.js';
import { todayDateString } from '#lib/utils/format.js';

export function isAiredEpisode(
	airDate: string | null | undefined,
	today: string = todayDateString()
): boolean {
	return Boolean(airDate && airDate !== '' && airDate <= today);
}

/** SQL form of the same rule, for queries that must filter server-side. */
export function airedSeasonCondition(seriesId: string, seasonNumber: number) {
	return and(
		eq(episodes.seriesId, seriesId),
		eq(episodes.seasonNumber, seasonNumber),
		lte(episodes.airDate, todayDateString())
	);
}

async function seasonEpisodes(seriesId: string, seasonNumber: number) {
	return db.query.episodes.findMany({
		where: airedSeasonCondition(seriesId, seasonNumber),
		columns: { id: true, airDate: true }
	});
}

export async function getAiredSeasonEpisodeIds(
	seriesId: string,
	seasonNumber: number
): Promise<string[]> {
	const today = todayDateString();
	const rows = await seasonEpisodes(seriesId, seasonNumber);
	return rows
		.filter((episode) => isAiredEpisode(episode.airDate, today))
		.map((episode) => episode.id);
}

export async function countAiredSeasonEpisodes(
	seriesId: string,
	seasonNumber: number
): Promise<number> {
	const today = todayDateString();
	const rows = await seasonEpisodes(seriesId, seasonNumber);
	return rows.filter((episode) => isAiredEpisode(episode.airDate, today)).length;
}

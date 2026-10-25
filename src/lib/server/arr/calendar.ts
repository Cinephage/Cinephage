/**
 * Radarr/Sonarr-compatible `calendar` response - reuses the same
 * Movie/Episode resources already built for /movie and /episode, filtered
 * to a date range. Radarr's calendar returns MovieResource[] (filtered by
 * releaseDate); Sonarr's returns EpisodeResource[] (filtered by airDate).
 */

import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { buildMovies } from './movies.js';
import { buildEpisodesForSeries } from './episodes.js';

interface CalendarOptions {
	start: Date | null;
	end: Date | null;
	unmonitored: boolean;
}

function inRange(dateStr: string | null | undefined, options: CalendarOptions): boolean {
	if (!dateStr) return false;
	const t = new Date(dateStr).getTime();
	if (Number.isNaN(t)) return false;
	if (options.start && t < options.start.getTime()) return false;
	if (options.end && t > options.end.getTime()) return false;
	return true;
}

export async function buildRadarrCalendar(
	options: CalendarOptions
): Promise<Record<string, unknown>[]> {
	const movies = await buildMovies();
	return movies.filter(
		(m) => (options.unmonitored || m.monitored) && inRange(m.releaseDate as string | null, options)
	);
}

export async function buildSonarrCalendar(
	options: CalendarOptions
): Promise<Record<string, unknown>[]> {
	const allSeries = await db.select({ id: series.id }).from(series);
	const allEpisodes = (
		await Promise.all(allSeries.map((s) => buildEpisodesForSeries({ seriesId: s.id })))
	).flat();
	return allEpisodes.filter(
		(e) => (options.unmonitored || e.monitored) && inRange(e.airDate as string | null, options)
	);
}

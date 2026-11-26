/**
 * The calendar feed's data: monitored movies, episodes and albums inside a
 * bounded window, projected into `CalendarEvent`s.
 *
 * DB-only on purpose. `getCalendarData` (the calendar page) fans out to TMDB on
 * every call and is month-scoped; a feed is polled by every subscriber's
 * calendar client, so reusing it would turn each poller into a TMDB rate-limit
 * incident. Freshness already exists elsewhere: `metadata-refresh` re-records
 * release events daily and `release-event-backfill` fills the gaps.
 */

import { and, asc, eq, gte, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, episodes, movies, releaseEvents, series } from '#lib/server/db/schema.js';
import { firstDownloadableEvent } from '#lib/server/availability/derive.js';
import { zonedWallClockToInstant } from '#lib/utils/airTime.js';
import { toDateString } from '#lib/utils/format.js';
import type { CalendarFeedConfig } from '#lib/validation/schemas.js';
import * as m from '#lib/paraglide/messages.js';
import type { CalendarEvent } from './ical.js';

/**
 * Google and Apple reject feeds far beyond this; a library-wide window this
 * size is already past what either will ingest in one poll.
 */
const MAX_FEED_EVENTS = 2000;

const DESCRIPTION_LIMIT = 700;

export interface CalendarFeedWindow {
	/** First day, inclusive (`YYYY-MM-DD`). */
	start: string;
	/** Last day, inclusive (`YYYY-MM-DD`). */
	end: string;
}

/** The window the feed covers, in the server's local calendar. */
export function calendarFeedWindow(
	config: CalendarFeedConfig,
	now = new Date()
): CalendarFeedWindow {
	const start = new Date(now);
	start.setDate(start.getDate() - config.daysPast);
	const end = new Date(now);
	end.setDate(end.getDate() + config.daysFuture);

	return { start: toDateString(start), end: toDateString(end) };
}

/** ISO timestamp → epoch seconds, 0 when absent or malformed. */
function revisionOf(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

/** A bare `YYYY-MM-DD` carries no clock; use its midnight as the revision. */
function revisionOfDate(dateISO: string): number {
	return revisionOf(`${dateISO}T00:00:00Z`);
}

function truncate(value: string, limit = DESCRIPTION_LIMIT): string {
	const trimmed = value.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function sortKey(event: CalendarEvent): string {
	return typeof event.start === 'string' ? event.start : event.start.toISOString();
}

function movieEvents(start: string, end: string): CalendarEvent[] {
	const rows = db
		.select({
			movieId: movies.id,
			title: movies.title,
			year: movies.year,
			kind: releaseEvents.kind,
			releaseDate: releaseEvents.releaseDate,
			releaseTime: releaseEvents.releaseTime,
			timezone: releaseEvents.timezone,
			region: releaseEvents.region,
			updatedAt: releaseEvents.updatedAt
		})
		.from(releaseEvents)
		// `media_id` is polymorphic (movie | series | episode), so the join and
		// the mediaType filter are what keep an episode's events out.
		.innerJoin(movies, eq(releaseEvents.mediaId, movies.id))
		.where(
			and(
				eq(releaseEvents.mediaType, 'movie'),
				eq(movies.monitored, true),
				// Theatrical/premiere are not obtainable moments.
				// `firstDownloadableEvent` does the kind filtering below; this
				// window is what keeps the row count bounded.
				gte(releaseEvents.releaseDate, start),
				lte(releaseEvents.releaseDate, end)
			)
		)
		.orderBy(asc(releaseEvents.releaseDate))
		.all();

	// One event per film: the earliest downloadable window, so a title with
	// digital + physical dates does not appear twice.
	const byMovie = new Map<string, typeof rows>();
	for (const row of rows) {
		const bucket = byMovie.get(row.movieId);
		if (bucket) bucket.push(row);
		else byMovie.set(row.movieId, [row]);
	}

	const events: CalendarEvent[] = [];
	for (const group of byMovie.values()) {
		const chosen = firstDownloadableEvent(group);
		if (!chosen) continue;

		const instant =
			chosen.releaseTime && chosen.timezone
				? zonedWallClockToInstant(chosen.releaseDate, chosen.releaseTime, chosen.timezone)
				: null;

		events.push({
			uid: `movie-${chosen.movieId}@cinephage`,
			summary: chosen.year ? `${chosen.title} (${chosen.year})` : chosen.title,
			description: m.calendar_feed_movieRelease({
				kind: chosen.kind,
				region: chosen.region
			}),
			categories: [m.calendar_feed_categoryMovie()],
			revision: revisionOf(chosen.updatedAt),
			start: instant ?? chosen.releaseDate
		});
	}

	return events;
}

function episodeEvents(
	start: string,
	end: string,
	filter: CalendarFeedConfig['seriesFilter']
): CalendarEvent[] {
	const seriesFilter =
		filter === 'anime'
			? eq(series.seriesType, 'anime')
			: filter === 'standard'
				? // Legacy rows may predate the column's default; treat null as standard.
					or(isNull(series.seriesType), ne(series.seriesType, 'anime'))
				: undefined;

	const rows = db
		.select({
			episodeId: episodes.id,
			episodeTitle: episodes.title,
			overview: episodes.overview,
			seasonNumber: episodes.seasonNumber,
			episodeNumber: episodes.episodeNumber,
			airDate: episodes.airDate,
			runtime: episodes.runtime,
			seriesTitle: series.title,
			airTime: series.airTime,
			airTz: series.airTz
		})
		.from(episodes)
		.innerJoin(series, eq(episodes.seriesId, series.id))
		.where(
			and(
				eq(episodes.monitored, true),
				eq(series.monitored, true),
				isNotNull(episodes.airDate),
				gte(episodes.airDate, start),
				lte(episodes.airDate, end),
				seriesFilter
			)
		)
		.orderBy(asc(episodes.airDate))
		.all();

	const events: CalendarEvent[] = [];
	for (const row of rows) {
		if (!row.airDate) continue;

		const instant =
			row.airTime && row.airTz
				? zonedWallClockToInstant(row.airDate, row.airTime, row.airTz)
				: null;
		const code = `S${String(row.seasonNumber).padStart(2, '0')}E${String(
			row.episodeNumber
		).padStart(2, '0')}`;
		const summary = row.episodeTitle
			? `${row.seriesTitle} ${code} - ${row.episodeTitle}`
			: `${row.seriesTitle} ${code}`;

		events.push({
			uid: `episode-${row.episodeId}@cinephage`,
			summary,
			// Without a broadcast time the episode is an all-day marker; guessing
			// an offset would put it on the wrong hour in half the world.
			description: row.overview ? truncate(row.overview) : undefined,
			categories: [m.calendar_feed_categoryEpisode()],
			// Episodes have no updatedAt; the air date is what moves, so it is the
			// revision that matters when TVDB shifts a schedule.
			revision: revisionOfDate(row.airDate),
			start: instant ?? row.airDate,
			durationMinutes: row.runtime && row.runtime > 0 ? row.runtime : undefined
		});
	}

	return events;
}

function albumEvents(start: string, end: string): CalendarEvent[] {
	const rows = db
		.select({
			albumId: albums.id,
			title: albums.title,
			primaryType: albums.primaryType,
			releaseDate: albums.releaseDate,
			artistName: artists.name
		})
		.from(albums)
		.leftJoin(artists, eq(albums.artistId, artists.id))
		.where(
			and(
				eq(albums.monitored, true),
				isNotNull(albums.releaseDate),
				gte(albums.releaseDate, start),
				lte(albums.releaseDate, end)
			)
		)
		.orderBy(asc(albums.releaseDate))
		.all();

	const events: CalendarEvent[] = [];
	for (const row of rows) {
		// MusicBrainz carries partial dates (`YYYY-MM`); only a full day can sit
		// on a calendar.
		if (!row.releaseDate || row.releaseDate.length !== 10) continue;

		events.push({
			uid: `album-${row.albumId}@cinephage`,
			summary: row.artistName ? `${row.artistName} - ${row.title}` : row.title,
			description: m.calendar_feed_albumRelease({ type: row.primaryType ?? 'Album' }),
			categories: [m.calendar_feed_categoryAlbum()],
			revision: revisionOfDate(row.releaseDate),
			start: row.releaseDate
		});
	}

	return events;
}

/**
 * Every event the given feed configuration covers, oldest first, capped.
 * The reminder lead time is applied here so every kind shares one VALARM rule.
 */
export async function getCalendarFeedEvents(
	config: CalendarFeedConfig,
	now = new Date()
): Promise<CalendarEvent[]> {
	const { start, end } = calendarFeedWindow(config, now);

	const events: CalendarEvent[] = [];
	if (config.movies) events.push(...movieEvents(start, end));
	if (config.episodes) events.push(...episodeEvents(start, end, config.seriesFilter));
	if (config.music) events.push(...albumEvents(start, end));

	events.sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.summary.localeCompare(b.summary));

	const alertMinutes = config.alertMinutes > 0 ? config.alertMinutes : undefined;
	return events.slice(0, MAX_FEED_EVENTS).map((event) => ({ ...event, alertMinutes }));
}

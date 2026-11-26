import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '#lib/server/db/schema.js';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { calendarFeedConfigSchema, type CalendarFeedConfig } from '#lib/validation/schemas.js';
import { getCalendarFeedEvents, calendarFeedWindow } from './feed.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

/** Fixed clock: 2026-11-25. Defaults cover 2026-11-18 .. 2027-02-23. */
const NOW = new Date(2026, 10, 25, 12, 0, 0);

function config(overrides: Partial<CalendarFeedConfig> = {}): CalendarFeedConfig {
	return calendarFeedConfigSchema.parse(overrides);
}

let tmdbSeq = 1000;

function seedMovie(options: {
	title?: string;
	year?: number;
	monitored?: boolean;
	events: Array<{ kind: string; releaseDate: string; releaseTime?: string; timezone?: string }>;
}): string {
	const id = randomUUID();
	tmdbSeq += 1;
	testDb.db
		.insert(schema.movies)
		.values({
			id,
			tmdbId: tmdbSeq,
			title: options.title ?? 'A Movie',
			year: options.year ?? 2026,
			monitored: options.monitored ?? true,
			path: `/media/movies/${id}`
		})
		.run();

	for (const event of options.events) {
		testDb.db
			.insert(schema.releaseEvents)
			.values({
				mediaType: 'movie',
				mediaId: id,
				kind: event.kind,
				releaseDate: event.releaseDate,
				releaseTime: event.releaseTime ?? null,
				timezone: event.timezone ?? null,
				source: 'tmdb',
				confidence: 'confirmed'
			})
			.run();
	}

	return id;
}

function seedEpisode(options: {
	seriesTitle?: string;
	seriesType?: string;
	seriesMonitored?: boolean;
	episodeMonitored?: boolean;
	season?: number;
	episode?: number;
	airDate: string | null;
	airTime?: string | null;
	airTz?: string | null;
	title?: string | null;
}): string {
	const seriesId = randomUUID();
	tmdbSeq += 1;
	testDb.db
		.insert(schema.series)
		.values({
			id: seriesId,
			tmdbId: tmdbSeq,
			title: options.seriesTitle ?? 'A Show',
			seriesType: options.seriesType ?? 'standard',
			monitored: options.seriesMonitored ?? true,
			airTime: options.airTime ?? null,
			airTz: options.airTz ?? null,
			path: `/media/tv/${seriesId}`
		})
		.run();

	const episodeId = randomUUID();
	testDb.db
		.insert(schema.episodes)
		.values({
			id: episodeId,
			seriesId,
			seasonNumber: options.season ?? 1,
			episodeNumber: options.episode ?? 1,
			airDate: options.airDate,
			title: options.title ?? 'Pilot',
			monitored: options.episodeMonitored ?? true
		})
		.run();

	return episodeId;
}

function seedAlbum(options: {
	title?: string;
	artist?: string;
	releaseDate: string | null;
	monitored?: boolean;
	primaryType?: string;
}): string {
	const mediaItemId = randomUUID();
	testDb.db
		.insert(schema.mediaItems)
		.values({ id: mediaItemId, kind: 'album', title: options.title ?? 'An Album' })
		.run();
	const artistId = randomUUID();
	testDb.db
		.insert(schema.artists)
		.values({ id: artistId, name: options.artist ?? 'An Artist' })
		.run();

	const albumId = randomUUID();
	testDb.db
		.insert(schema.albums)
		.values({
			id: albumId,
			mediaItemId,
			artistId,
			title: options.title ?? 'An Album',
			releaseDate: options.releaseDate,
			monitored: options.monitored ?? true,
			primaryType: options.primaryType ?? 'Album'
		})
		.run();

	return albumId;
}

beforeEach(() => {
	clearTestDb(testDb);
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('calendarFeedWindow', () => {
	it('spans the configured past and future days', () => {
		expect(calendarFeedWindow(config(), NOW)).toEqual({
			start: '2026-11-18',
			end: '2027-02-23'
		});
	});
});

describe('getCalendarFeedEvents movies', () => {
	it('emits one event per film at the earliest downloadable window', async () => {
		seedMovie({
			title: 'Dune Part Three',
			year: 2027,
			events: [
				{ kind: 'digital', releaseDate: '2026-12-01' },
				{ kind: 'physical', releaseDate: '2026-12-20' }
			]
		});

		const events = await getCalendarFeedEvents(config(), NOW);

		expect(events).toHaveLength(1);
		expect(events[0].summary).toBe('Dune Part Three (2027)');
		expect(events[0].start).toBe('2026-12-01');
		expect(events[0].uid).toMatch(/^movie-.+@cinephage$/);
	});

	it('ignores theatrical-only and unmonitored films', async () => {
		seedMovie({ events: [{ kind: 'theatrical', releaseDate: '2026-12-01' }] });
		seedMovie({ monitored: false, events: [{ kind: 'digital', releaseDate: '2026-12-01' }] });

		expect(await getCalendarFeedEvents(config(), NOW)).toHaveLength(0);
	});

	it('leaves events outside the window alone', async () => {
		seedMovie({ events: [{ kind: 'digital', releaseDate: '2028-06-01' }] });

		expect(await getCalendarFeedEvents(config(), NOW)).toHaveLength(0);
	});
});

describe('getCalendarFeedEvents episodes', () => {
	it('uses the broadcast instant when the time and zone are known', async () => {
		seedEpisode({
			seriesTitle: 'Severance',
			airDate: '2026-12-01',
			airTime: '21:00',
			airTz: 'America/New_York',
			title: 'Cold Harbor'
		});

		const events = await getCalendarFeedEvents(config(), NOW);

		expect(events).toHaveLength(1);
		expect(events[0].summary).toBe('Severance S01E01 - Cold Harbor');
		expect(events[0].start).toBeInstanceOf(Date);
		expect((events[0].start as Date).toISOString()).toBe('2026-12-02T02:00:00.000Z');
	});

	it('falls back to an all-day event without a timezone', async () => {
		seedEpisode({ airDate: '2026-12-01', airTime: '21:00', airTz: null });

		const events = await getCalendarFeedEvents(config(), NOW);

		expect(events[0].start).toBe('2026-12-01');
	});

	it('drops unmonitored episodes and unmonitored series', async () => {
		seedEpisode({ airDate: '2026-12-01', episodeMonitored: false });
		seedEpisode({ airDate: '2026-12-02', seriesMonitored: false });
		seedEpisode({ airDate: null });

		expect(await getCalendarFeedEvents(config(), NOW)).toHaveLength(0);
	});

	it('honours the series filter', async () => {
		seedEpisode({ airDate: '2026-12-01', seriesTitle: 'Frieren', seriesType: 'anime' });
		seedEpisode({ airDate: '2026-12-02', seriesTitle: 'The Bear', seriesType: 'standard' });

		const anime = await getCalendarFeedEvents(config({ seriesFilter: 'anime' }), NOW);
		expect(anime.map((event) => event.summary)).toEqual(['Frieren S01E01 - Pilot']);

		const liveAction = await getCalendarFeedEvents(config({ seriesFilter: 'standard' }), NOW);
		expect(liveAction.map((event) => event.summary)).toEqual(['The Bear S01E01 - Pilot']);

		expect(await getCalendarFeedEvents(config({ seriesFilter: 'all' }), NOW)).toHaveLength(2);
	});
});

describe('getCalendarFeedEvents music', () => {
	it('is off by default and included when enabled', async () => {
		seedAlbum({ title: 'Homework', artist: 'Daft Punk', releaseDate: '2026-12-05' });

		expect(await getCalendarFeedEvents(config(), NOW)).toHaveLength(0);

		const events = await getCalendarFeedEvents(config({ music: true }), NOW);
		expect(events).toHaveLength(1);
		expect(events[0].summary).toBe('Daft Punk - Homework');
		expect(events[0].start).toBe('2026-12-05');
		expect(events[0].uid).toMatch(/^album-.+@cinephage$/);
	});

	it('skips partial dates and unmonitored albums', async () => {
		seedAlbum({ releaseDate: '2026-12' });
		seedAlbum({ releaseDate: '2026-12-05', monitored: false });

		expect(await getCalendarFeedEvents(config({ music: true }), NOW)).toHaveLength(0);
	});
});

describe('getCalendarFeedEvents options', () => {
	it('turns kinds off independently', async () => {
		seedMovie({ events: [{ kind: 'digital', releaseDate: '2026-12-01' }] });
		seedEpisode({ airDate: '2026-12-01' });

		const onlyShows = await getCalendarFeedEvents(config({ movies: false }), NOW);
		expect(onlyShows).toHaveLength(1);
		expect(onlyShows[0].uid).toMatch(/^episode-/);
	});

	it('applies the reminder lead time to every event', async () => {
		seedMovie({ events: [{ kind: 'digital', releaseDate: '2026-12-01' }] });
		seedEpisode({ airDate: '2026-12-02' });

		const events = await getCalendarFeedEvents(config({ alertMinutes: 60 }), NOW);
		expect(events.every((event) => event.alertMinutes === 60)).toBe(true);

		const quiet = await getCalendarFeedEvents(config({ alertMinutes: 0 }), NOW);
		expect(quiet.every((event) => event.alertMinutes === undefined)).toBe(true);
	});

	it('sorts oldest first', async () => {
		seedMovie({ events: [{ kind: 'digital', releaseDate: '2026-12-10' }] });
		seedEpisode({ airDate: '2026-12-01' });

		const events = await getCalendarFeedEvents(config(), NOW);
		expect(
			events.map((event) => (typeof event.start === 'string' ? event.start : 'timed'))
		).toEqual(['2026-12-01', '2026-12-10']);
	});
});

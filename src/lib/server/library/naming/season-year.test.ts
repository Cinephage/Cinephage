import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../../test/db-helper.js';
import { episodes, seasons, series } from '#lib/server/db/schema.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { resolveSeasonYear, seasonYearFromEpisodes, yearOfDate } = await import('./season-year.js');

const SERIES = 'series-1';

describe('yearOfDate', () => {
	it('takes the year from a date string', () => {
		expect(yearOfDate('2022-09-08')).toBe(2022);
		expect(yearOfDate('1999-01-01T00:00:00.000Z')).toBe(1999);
	});
	it('returns undefined for nothing or nonsense', () => {
		expect(yearOfDate(null)).toBeUndefined();
		expect(yearOfDate('')).toBeUndefined();
		expect(yearOfDate('not a date')).toBeUndefined();
	});
});

describe('seasonYearFromEpisodes', () => {
	it('takes the earliest air date of that season only', () => {
		const list = [
			{ seasonNumber: 23, airDate: '2022-09-08' },
			{ seasonNumber: 23, airDate: '2022-01-05' },
			{ seasonNumber: 24, airDate: '2019-01-01' }
		];
		expect(seasonYearFromEpisodes(list, 23)).toBe(2022);
	});
	it('ignores episodes with no air date', () => {
		expect(seasonYearFromEpisodes([{ seasonNumber: 1, airDate: null }], 1)).toBeUndefined();
	});
});

describe('resolveSeasonYear', () => {
	beforeEach(() => {
		testDb.sqlite.exec('DELETE FROM seasons; DELETE FROM episodes; DELETE FROM series;');
		testDb.db
			.insert(series)
			.values({ id: SERIES, tmdbId: 990669, title: 'Show', path: 'Show' })
			.run();
	});

	function seedSeason(seasonNumber: number, airDate: string | null) {
		testDb.db
			.insert(seasons)
			.values({ id: `s-${seasonNumber}`, seriesId: SERIES, seasonNumber, airDate })
			.run();
	}
	function seedEpisode(seasonNumber: number, episodeNumber: number, airDate: string | null) {
		testDb.db
			.insert(episodes)
			.values({
				id: `e-${seasonNumber}-${episodeNumber}`,
				seriesId: SERIES,
				seasonNumber,
				episodeNumber,
				airDate
			})
			.run();
	}

	it('prefers the stored season air date', async () => {
		seedSeason(23, '2022-09-08');
		seedEpisode(23, 1, '2023-01-01');
		expect(await resolveSeasonYear({ seriesId: SERIES, seasonNumber: 23 })).toBe(2022);
	});

	it('falls back to the earliest episode air date', async () => {
		seedSeason(23, null);
		seedEpisode(23, 2, '2022-06-01');
		seedEpisode(23, 1, '2022-01-05');
		expect(await resolveSeasonYear({ seriesId: SERIES, seasonNumber: 23 })).toBe(2022);
	});

	it('falls back to the air date the caller holds', async () => {
		seedSeason(23, null);
		expect(
			await resolveSeasonYear({
				seriesId: SERIES,
				seasonNumber: 23,
				fallbackAirDate: '2025-03-04'
			})
		).toBe(2025);
	});

	it('returns undefined when nothing is known', async () => {
		seedSeason(23, null);
		expect(await resolveSeasonYear({ seriesId: SERIES, seasonNumber: 23 })).toBeUndefined();
	});

	it('works without a series (import planning)', async () => {
		expect(await resolveSeasonYear({ fallbackAirDate: '2024-11-02' })).toBe(2024);
	});
});

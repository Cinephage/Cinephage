import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';
import {
	movies,
	movieFiles,
	series,
	episodes,
	episodeFiles,
	scoringProfiles,
	rootFolders
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/tmdb.js', () => ({ tmdb: { searchMovies: vi.fn(), getMovie: vi.fn() } }));

const { buildWantedMissing, buildWantedCutoff } = await import('./wanted.js');

const PROFILE_ID = 'profile-1';

beforeEach(() => {
	testDb.db.delete(episodeFiles).run();
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();
	testDb.db.delete(movieFiles).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(rootFolders).run();
	testDb.db.delete(scoringProfiles).run();

	testDb.db
		.insert(scoringProfiles)
		.values({ id: PROFILE_ID, name: 'HD', minResolution: '1080p' })
		.run();
});

describe('buildWantedMissing', () => {
	it('only includes monitored movies with no file that have already aired', async () => {
		const past = new Date(Date.now() - 86_400_000).toISOString();
		const future = new Date(Date.now() + 86_400_000).toISOString();

		testDb.db
			.insert(movies)
			.values([
				{
					id: 'm-missing',
					tmdbId: 1,
					title: 'Missing',
					path: '/m1',
					monitored: true,
					hasFile: false,
					releaseDate: past
				},
				{
					id: 'm-future',
					tmdbId: 2,
					title: 'Future',
					path: '/m2',
					monitored: true,
					hasFile: false,
					releaseDate: future
				},
				{
					id: 'm-unmonitored',
					tmdbId: 3,
					title: 'Unmonitored',
					path: '/m3',
					monitored: false,
					hasFile: false,
					releaseDate: past
				}
			])
			.run();

		const result = await buildWantedMissing('Radarr', {
			page: 1,
			pageSize: 10,
			sortKey: null,
			sortDirection: 'default'
		});
		expect(result.totalRecords).toBe(1);
		expect(result.records[0].title).toBe('Missing');
	});
});

describe('buildWantedCutoff', () => {
	it('includes a movie whose file resolution is below its profile minimum', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'm-lowres',
				tmdbId: 10,
				title: 'Low Res',
				path: '/lowres',
				scoringProfileId: PROFILE_ID
			})
			.run();
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'f-lowres',
				movieId: 'm-lowres',
				relativePath: 'movie.mkv',
				quality: { resolution: '720p' }
			})
			.run();

		const result = await buildWantedCutoff('Radarr', {
			page: 1,
			pageSize: 10,
			sortKey: null,
			sortDirection: 'default'
		});
		expect(result.totalRecords).toBe(1);
		expect(result.records[0].title).toBe('Low Res');
	});

	it('excludes a movie whose file already meets the cutoff', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'm-hires',
				tmdbId: 11,
				title: 'Hi Res',
				path: '/hires',
				scoringProfileId: PROFILE_ID
			})
			.run();
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'f-hires',
				movieId: 'm-hires',
				relativePath: 'movie.mkv',
				quality: { resolution: '2160p' }
			})
			.run();

		const result = await buildWantedCutoff('Radarr', {
			page: 1,
			pageSize: 10,
			sortKey: null,
			sortDirection: 'default'
		});
		expect(result.totalRecords).toBe(0);
	});

	it('excludes a movie with no scoring profile (no cutoff to compare against)', async () => {
		testDb.db
			.insert(movies)
			.values({ id: 'm-noprofile', tmdbId: 12, title: 'No Profile', path: '/np' })
			.run();
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'f-noprofile',
				movieId: 'm-noprofile',
				relativePath: 'movie.mkv',
				quality: { resolution: '480p' }
			})
			.run();

		const result = await buildWantedCutoff('Radarr', {
			page: 1,
			pageSize: 10,
			sortKey: null,
			sortDirection: 'default'
		});
		expect(result.totalRecords).toBe(0);
	});

	it('finds episodes below cutoff for the Sonarr persona', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 's-1',
				tmdbId: 20,
				title: 'Show',
				path: '/show',
				scoringProfileId: PROFILE_ID
			})
			.run();
		testDb.db
			.insert(episodes)
			.values({
				id: 'e-1',
				seriesId: 's-1',
				seasonNumber: 1,
				episodeNumber: 1,
				title: 'Pilot',
				hasFile: true
			})
			.run();
		testDb.db
			.insert(episodeFiles)
			.values({
				id: 'ef-1',
				seriesId: 's-1',
				seasonNumber: 1,
				episodeIds: ['e-1'],
				relativePath: 'S01E01.mkv',
				quality: { resolution: '720p' }
			})
			.run();

		const result = await buildWantedCutoff('Sonarr', {
			page: 1,
			pageSize: 10,
			sortKey: null,
			sortDirection: 'default'
		});
		expect(result.totalRecords).toBe(1);
		expect(result.records[0].title).toBe('Pilot');
	});
});

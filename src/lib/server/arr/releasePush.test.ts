import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { movies, series, episodes, scoringProfiles } from '#lib/server/db/schema.js';

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

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn()
	}),
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn()
	}
}));

const { pushRelease } = await import('./releasePush.js');

function fetchMock(response: { ok: boolean; status: number; body: unknown }): typeof fetch {
	return vi.fn().mockResolvedValue({
		ok: response.ok,
		status: response.status,
		json: async () => response.body
	}) as unknown as typeof fetch;
}

const grabOk = fetchMock({ ok: true, status: 200, body: { success: true } });

beforeEach(() => {
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(scoringProfiles).run();
});

describe('pushRelease - validation', () => {
	it('rejects with 400 when title is missing', async () => {
		const result = await pushRelease('radarr', { downloadUrl: 'magnet:x' }, grabOk);
		expect(result.status).toBe(400);
		expect(result.body).toEqual([
			expect.objectContaining({ propertyName: 'title', errorCode: 'InvalidRequest' })
		]);
	});

	it('rejects with 400 when neither downloadUrl nor magnetUrl is present', async () => {
		const result = await pushRelease('radarr', { title: 'Some Movie 2020 1080p BluRay' }, grabOk);
		expect(result.status).toBe(400);
		expect(result.body).toEqual([
			expect.objectContaining({ propertyName: 'downloadUrl', errorCode: 'InvalidRequest' })
		]);
	});
});

describe('pushRelease - movies', () => {
	it('approves and grabs a matching, monitored movie that meets quality', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-1',
				tmdbId: 1,
				title: 'Inception',
				year: 2010,
				path: '/movies/inception',
				monitored: true
			})
			.run();

		const fetchFn = fetchMock({ ok: true, status: 200, body: { success: true } });
		const result = await pushRelease(
			'radarr',
			{
				title: 'Inception 2010 1080p BluRay x264-GROUP',
				downloadUrl: 'https://example.com/download/1',
				size: 8_000_000_000,
				indexer: 'TestIndexer',
				downloadProtocol: 'torrent',
				publishDate: new Date().toISOString()
			},
			fetchFn
		);

		expect(result.status).toBe(200);
		expect(result.body).toEqual([
			{ approved: true, rejected: false, temporarilyRejected: false, rejections: [] }
		]);
		expect(fetchFn).toHaveBeenCalledWith(
			'/api/download/grab',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('rejects when no library movie matches the title', async () => {
		const result = await pushRelease(
			'radarr',
			{
				title: 'Some Totally Unknown Movie Nobody Added 2020 1080p BluRay',
				downloadUrl: 'https://example.com/download/2'
			},
			grabOk
		);

		expect(result.status).toBe(200);
		expect(result.body).toEqual([
			{
				approved: false,
				rejected: true,
				temporarilyRejected: false,
				rejections: ['No matching movie found in library']
			}
		]);
	});

	it('rejects when the matched movie is not monitored', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-2',
				tmdbId: 2,
				title: 'The Matrix',
				year: 1999,
				path: '/movies/the-matrix',
				monitored: false
			})
			.run();

		const result = await pushRelease(
			'radarr',
			{
				title: 'The Matrix 1999 1080p BluRay x264-GROUP',
				downloadUrl: 'https://example.com/download/3'
			},
			grabOk
		);

		expect(result.body).toEqual([
			{
				approved: false,
				rejected: true,
				temporarilyRejected: false,
				rejections: ['Movie is not monitored']
			}
		]);
	});

	it('rejects when the release fails the quality profile', async () => {
		testDb.db
			.insert(scoringProfiles)
			.values({
				id: 'usenet-only',
				name: 'Usenet Only',
				allowedProtocols: ['usenet'],
				minScore: 0,
				formatScores: {}
			})
			.run();
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-3',
				tmdbId: 3,
				title: 'Interstellar',
				year: 2014,
				path: '/movies/interstellar',
				monitored: true,
				scoringProfileId: 'usenet-only'
			})
			.run();

		const result = await pushRelease(
			'radarr',
			{
				title: 'Interstellar 2014 1080p BluRay x264-GROUP',
				downloadUrl: 'https://example.com/download/4',
				downloadProtocol: 'torrent'
			},
			grabOk
		);

		expect(result.body).toEqual([
			{
				approved: false,
				rejected: true,
				temporarilyRejected: false,
				rejections: [expect.stringContaining("Protocol 'torrent' not allowed")]
			}
		]);
	});
});

describe('pushRelease - series', () => {
	it('approves and grabs a matching, monitored episode that meets quality', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 'series-1',
				tmdbId: 100,
				title: 'Breaking Bad',
				year: 2008,
				path: '/tv/breaking-bad',
				monitored: true
			})
			.run();
		testDb.db
			.insert(episodes)
			.values({
				id: 'ep-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeNumber: 1,
				title: 'Pilot',
				monitored: true
			})
			.run();

		const fetchFn = fetchMock({ ok: true, status: 200, body: { success: true } });
		const result = await pushRelease(
			'sonarr',
			{
				title: 'Breaking Bad S01E01 1080p BluRay x264-GROUP',
				downloadUrl: 'https://example.com/download/5',
				downloadProtocol: 'torrent'
			},
			fetchFn
		);

		expect(result.body).toEqual([
			{ approved: true, rejected: false, temporarilyRejected: false, rejections: [] }
		]);
		expect(fetchFn).toHaveBeenCalledWith(
			'/api/download/grab',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('rejects when no library series matches the title', async () => {
		const result = await pushRelease(
			'sonarr',
			{
				title: 'Some Totally Unknown Show Nobody Added S01E01 1080p',
				downloadUrl: 'https://example.com/download/6'
			},
			grabOk
		);

		expect(result.body).toEqual([
			{
				approved: false,
				rejected: true,
				temporarilyRejected: false,
				rejections: ['No matching series found in library']
			}
		]);
	});

	it('rejects when the matched episode is not monitored', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 'series-2',
				tmdbId: 200,
				title: 'The Wire',
				year: 2002,
				path: '/tv/the-wire',
				monitored: true
			})
			.run();
		testDb.db
			.insert(episodes)
			.values({
				id: 'ep-2',
				seriesId: 'series-2',
				seasonNumber: 1,
				episodeNumber: 1,
				title: 'The Target',
				monitored: false
			})
			.run();

		const result = await pushRelease(
			'sonarr',
			{
				title: 'The Wire S01E01 1080p BluRay x264-GROUP',
				downloadUrl: 'https://example.com/download/7'
			},
			grabOk
		);

		expect(result.body).toEqual([
			{
				approved: false,
				rejected: true,
				temporarilyRejected: false,
				rejections: ['Episode is not monitored']
			}
		]);
	});
});

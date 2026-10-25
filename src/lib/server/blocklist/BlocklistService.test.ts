import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { blocklist, movies, series } from '#lib/server/db/schema.js';

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

const { blocklistService } = await import('./BlocklistService.js');

const MOVIE_ID = 'movie-1';
const SERIES_ID = 'series-1';

function insertEntry(overrides: Partial<typeof blocklist.$inferInsert> = {}) {
	testDb.db
		.insert(blocklist)
		.values({
			title: 'Some.Release.1080p',
			reason: 'download_failed',
			sourceTitle: 'Some.Release.1080p',
			...overrides
		})
		.run();
}

describe('BlocklistService.getBlockedIdentifiers', () => {
	beforeEach(() => {
		testDb.db.delete(blocklist).run();
		testDb.db.delete(movies).run();
		testDb.db.delete(series).run();
		testDb.db
			.insert(movies)
			.values([
				{ id: MOVIE_ID, tmdbId: 101, title: 'Movie One', path: '/media/movie-one' },
				{ id: 'other-movie', tmdbId: 102, title: 'Movie Two', path: '/media/movie-two' }
			])
			.run();
		testDb.db
			.insert(series)
			.values({ id: SERIES_ID, tmdbId: 201, title: 'Series One', path: '/media/series-one' })
			.run();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('returns hashes and titles scoped to the given movie', async () => {
		insertEntry({
			movieId: MOVIE_ID,
			infoHash: 'HASH_A',
			sourceTitle: 'Movie.Release.A'
		});
		insertEntry({
			movieId: 'other-movie',
			infoHash: 'HASH_OTHER',
			sourceTitle: 'Other.Release'
		});

		const { blockedHashes, blockedTitles } = await blocklistService.getBlockedIdentifiers(MOVIE_ID);

		expect(blockedHashes.has('HASH_A')).toBe(true);
		expect(blockedTitles.has('Movie.Release.A')).toBe(true);
		expect(blockedHashes.has('HASH_OTHER')).toBe(false);
		expect(blockedTitles.has('Other.Release')).toBe(false);
	});

	it('scopes to the given series when seriesId is provided', async () => {
		insertEntry({
			seriesId: SERIES_ID,
			infoHash: 'SERIES_HASH',
			sourceTitle: 'Series.Release'
		});

		const { blockedHashes, blockedTitles } = await blocklistService.getBlockedIdentifiers(
			undefined,
			SERIES_ID
		);

		expect(blockedHashes.has('SERIES_HASH')).toBe(true);
		expect(blockedTitles.has('Series.Release')).toBe(true);
	});

	it('excludes expired entries but keeps never-expiring ones', async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		insertEntry({
			movieId: MOVIE_ID,
			infoHash: 'EXPIRED_HASH',
			sourceTitle: 'Expired.Release',
			expiresAt: past
		});
		insertEntry({
			movieId: MOVIE_ID,
			infoHash: 'PERMANENT_HASH',
			sourceTitle: 'Permanent.Release',
			expiresAt: null
		});

		const { blockedHashes, blockedTitles } = await blocklistService.getBlockedIdentifiers(MOVIE_ID);

		expect(blockedHashes.has('PERMANENT_HASH')).toBe(true);
		expect(blockedTitles.has('Permanent.Release')).toBe(true);
		expect(blockedHashes.has('EXPIRED_HASH')).toBe(false);
		expect(blockedTitles.has('Expired.Release')).toBe(false);
	});

	it('includes entries whose expiry is still in the future', async () => {
		const future = new Date(Date.now() + 60 * 60_000).toISOString();
		insertEntry({
			movieId: MOVIE_ID,
			infoHash: 'FUTURE_HASH',
			sourceTitle: 'Future.Release',
			expiresAt: future
		});

		const { blockedHashes } = await blocklistService.getBlockedIdentifiers(MOVIE_ID);

		expect(blockedHashes.has('FUTURE_HASH')).toBe(true);
	});

	it('omits null infoHash and sourceTitle values from the sets', async () => {
		insertEntry({
			movieId: MOVIE_ID,
			infoHash: null,
			sourceTitle: null,
			title: 'No.Identifiers'
		});

		const { blockedHashes, blockedTitles } = await blocklistService.getBlockedIdentifiers(MOVIE_ID);

		expect(blockedHashes.size).toBe(0);
		expect(blockedTitles.size).toBe(0);
	});

	it('returns empty sets when nothing is blocked for the target', async () => {
		const { blockedHashes, blockedTitles } =
			await blocklistService.getBlockedIdentifiers('unknown-movie');

		expect(blockedHashes.size).toBe(0);
		expect(blockedTitles.size).toBe(0);
	});
});

/**
 * Manually-triggered "Auto-grab" attempts (movie/episode/season/
 * series-missing buttons on a library page) should land in monitoringHistory
 * tagged taskType 'manual' - visible in the Activity page's Searches tab by
 * default, same as a scheduled search, per issue #658's goal of surfacing a
 * retry pattern regardless of what triggered it.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { movies, episodes, series, monitoringHistory } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const { recordManualSearchAttempt, recordManualMultiItemResults } =
	await import('./manual-search-history.js');

afterAll(() => destroyTestDb(testDb));

beforeEach(() => {
	testDb.db.delete(monitoringHistory).run();
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();
	testDb.db.delete(movies).run();
});

describe('recordManualSearchAttempt', () => {
	it('logs a grabbed movie result and updates lastSearchTime', async () => {
		const movieId = randomUUID();
		await testDb.db
			.insert(movies)
			.values({ id: movieId, tmdbId: 1, title: 'Test Movie', path: `/movies/${movieId}` });

		await recordManualSearchAttempt(
			{ movieId },
			{
				success: true,
				releaseName: 'Test.Movie.2024.1080p',
				queueItemId: 'q1',
				indexerId: 'idx-1',
				indexerName: 'Test Indexer',
				indexersQueried: 3
			}
		);

		const [row] = await testDb.db.select().from(monitoringHistory);
		expect(row.taskType).toBe('manual');
		expect(row.movieId).toBe(movieId);
		expect(row.status).toBe('grabbed');
		expect(row.releaseGrabbed).toBe('Test.Movie.2024.1080p');
		expect(row.indexerId).toBe('idx-1');
		expect(row.indexerName).toBe('Test Indexer');
		expect(row.indexersQueried).toBe(3);

		const [movie] = await testDb.db.select().from(movies).where(eq(movies.id, movieId));
		expect(movie.lastSearchTime).not.toBeNull();
	});

	it('classifies a "no suitable releases found" error as no_results, not error', async () => {
		const movieId = randomUUID();
		await testDb.db
			.insert(movies)
			.values({ id: movieId, tmdbId: 2, title: 'No Results Movie', path: `/movies/${movieId}` });

		await recordManualSearchAttempt(
			{ movieId },
			{ success: false, error: 'No suitable releases found' }
		);

		const [row] = await testDb.db.select().from(monitoringHistory);
		expect(row.status).toBe('no_results');
	});

	it('classifies any other failure as error', async () => {
		const movieId = randomUUID();
		await testDb.db
			.insert(movies)
			.values({ id: movieId, tmdbId: 3, title: 'Broken Movie', path: `/movies/${movieId}` });

		await recordManualSearchAttempt({ movieId }, { success: false, error: 'Indexer timed out' });

		const [row] = await testDb.db.select().from(monitoringHistory);
		expect(row.status).toBe('error');
	});

	it('logs a season-pack grab against seasonNumber, not an episodeId', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 10, title: 'Test Series', path: `/tv/${seriesId}` });

		await recordManualSearchAttempt(
			{ seriesId, seasonNumber: 2 },
			{ success: true, releaseName: 'Test.Series.S02.1080p' }
		);

		const [row] = await testDb.db.select().from(monitoringHistory);
		expect(row.seriesId).toBe(seriesId);
		expect(row.seasonNumber).toBe(2);
		expect(row.episodeId).toBeNull();
	});
});

describe('recordManualMultiItemResults', () => {
	it('logs a grabbed episode against its own id and updates its lastSearchTime', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 20, title: 'Multi Series', path: `/tv/${seriesId}` });
		const episodeId = randomUUID();
		await testDb.db
			.insert(episodes)
			.values({ id: episodeId, seriesId, seasonNumber: 1, episodeNumber: 1 });

		await recordManualMultiItemResults(seriesId, [
			{
				itemId: episodeId,
				itemLabel: 'S01E01',
				found: true,
				grabbed: true,
				releaseName: 'Episode.Release',
				indexerId: 'idx-7',
				indexerName: 'Multi Indexer',
				indexersQueried: 2
			}
		]);

		const [row] = await testDb.db.select().from(monitoringHistory);
		expect(row.episodeId).toBe(episodeId);
		expect(row.seasonNumber).toBeNull();
		expect(row.status).toBe('grabbed');
		expect(row.indexerId).toBe('idx-7');
		expect(row.indexerName).toBe('Multi Indexer');
		expect(row.indexersQueried).toBe(2);

		const [episode] = await testDb.db.select().from(episodes).where(eq(episodes.id, episodeId));
		expect(episode.lastSearchTime).not.toBeNull();
	});

	it('logs a pack-grabbed representative episode against the season instead', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 21, title: 'Pack Series', path: `/tv/${seriesId}` });
		const episodeId = randomUUID();
		await testDb.db
			.insert(episodes)
			.values({ id: episodeId, seriesId, seasonNumber: 3, episodeNumber: 1 });

		await recordManualMultiItemResults(seriesId, [
			{
				itemId: episodeId,
				itemLabel: 'Season 3',
				found: true,
				grabbed: true,
				releaseName: 'Season.3.Pack',
				wasPackGrab: true
			}
		]);

		const [row] = await testDb.db.select().from(monitoringHistory);
		expect(row.episodeId).toBeNull();
		expect(row.seasonNumber).toBe(3);
	});

	it('folds a found-but-not-grabbed item into no_results (no separate "found" status), while releasesFound still reflects it', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 22, title: 'Found Series', path: `/tv/${seriesId}` });
		const episodeId = randomUUID();
		await testDb.db
			.insert(episodes)
			.values({ id: episodeId, seriesId, seasonNumber: 1, episodeNumber: 2 });

		await recordManualMultiItemResults(seriesId, [
			{ itemId: episodeId, itemLabel: 'S01E02', found: true, grabbed: false }
		]);

		const [row] = await testDb.db.select().from(monitoringHistory);
		expect(row.status).toBe('no_results');
		expect(row.releasesFound).toBe(1);
	});

	it('does nothing for an empty results array', async () => {
		await expect(recordManualMultiItemResults(randomUUID(), [])).resolves.toBeUndefined();
		const rows = await testDb.db.select().from(monitoringHistory);
		expect(rows).toHaveLength(0);
	});
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';
import {
	downloadClients,
	downloadQueue,
	episodeFiles,
	episodes,
	movieFiles,
	movies,
	series
} from '#lib/server/db/schema.js';

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

const { mediaOccupancyService } = await import('./MediaOccupancyService.js');

function resetDb() {
	testDb.sqlite.exec(`
		DELETE FROM acquisition_reservations;
		DELETE FROM acquisition_intents;
		DELETE FROM download_queue;
		DELETE FROM episode_files;
		DELETE FROM movie_files;
		DELETE FROM episodes;
		DELETE FROM series;
		DELETE FROM movies;
		DELETE FROM download_clients;
	`);
}

function insertDownloadClient() {
	testDb.db
		.insert(downloadClients)
		.values({
			id: 'client-1',
			name: 'qBittorrent',
			implementation: 'qbittorrent',
			host: 'localhost',
			port: 8080
		})
		.run();
}

function insertMovie(overrides: Partial<typeof movies.$inferInsert> = {}) {
	testDb.db
		.insert(movies)
		.values({
			id: 'movie-1',
			tmdbId: 100,
			title: 'Test Movie',
			path: 'Test Movie (2026)',
			...overrides
		})
		.run();
}

function insertSeriesEpisode(overrides: Partial<typeof episodes.$inferInsert> = {}) {
	testDb.db
		.insert(series)
		.values({
			id: 'series-1',
			tmdbId: 200,
			title: 'Test Series',
			path: 'Test Series'
		})
		.run();

	testDb.db
		.insert(episodes)
		.values({
			id: 'episode-1',
			seriesId: 'series-1',
			seasonNumber: 1,
			episodeNumber: 1,
			title: 'Pilot',
			...overrides
		})
		.run();
}

describe('MediaOccupancyService', () => {
	beforeEach(() => {
		resetDb();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('marks a movie occupied when it has an active queue item', async () => {
		insertDownloadClient();
		insertMovie();
		testDb.db
			.insert(downloadQueue)
			.values({
				id: 'queue-1',
				downloadClientId: 'client-1',
				downloadId: 'remote-1',
				title: 'Test.Movie.2026.1080p',
				movieId: 'movie-1',
				status: 'downloading',
				protocol: 'torrent'
			})
			.run();

		const result = await mediaOccupancyService.check({ type: 'movie', movieId: 'movie-1' });

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('movie_already_downloading');
	});

	it('marks an episode occupied when any active queue item overlaps its episode IDs', async () => {
		insertDownloadClient();
		insertSeriesEpisode();
		testDb.db
			.insert(downloadQueue)
			.values({
				id: 'queue-1',
				downloadClientId: 'client-1',
				downloadId: 'remote-1',
				title: 'Test.Series.S01E01.1080p',
				seriesId: 'series-1',
				episodeIds: ['episode-1'],
				seasonNumber: 1,
				status: 'queued',
				protocol: 'torrent'
			})
			.run();

		const result = await mediaOccupancyService.check({
			type: 'episode',
			seriesId: 'series-1',
			episodeId: 'episode-1'
		});

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('episode_already_downloading');
	});

	it('marks a movie occupied when it already has a file', async () => {
		insertMovie({ hasFile: true });
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-1',
				movieId: 'movie-1',
				relativePath: 'Test Movie (2026)/Test.Movie.2026.mkv'
			})
			.run();

		const result = await mediaOccupancyService.check({ type: 'movie', movieId: 'movie-1' });

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('movie_already_has_file');
	});

	it('marks an episode occupied when it already has a file', async () => {
		insertSeriesEpisode({ hasFile: true });
		testDb.db
			.insert(episodeFiles)
			.values({
				id: 'file-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeIds: ['episode-1'],
				relativePath: 'Season 01/Test.Series.S01E01.mkv'
			})
			.run();

		const result = await mediaOccupancyService.check({
			type: 'episode',
			seriesId: 'series-1',
			episodeId: 'episode-1'
		});

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('episode_already_has_file');
	});

	it('does not mark existing files occupied for an upgrade check', async () => {
		insertSeriesEpisode({ hasFile: true });
		testDb.db
			.insert(episodeFiles)
			.values({
				id: 'file-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeIds: ['episode-1'],
				relativePath: 'Season 01/Test.Series.S01E01.mkv'
			})
			.run();

		const result = await mediaOccupancyService.check(
			{ type: 'episode', seriesId: 'series-1', episodeId: 'episode-1' },
			{ isUpgrade: true }
		);

		expect(result.occupied).toBe(false);
	});

	it('allows a non-upgrade grab for an empty quality bucket in multi-quality mode', async () => {
		insertMovie({ desiredQualities: ['2160p', '1080p'] });
		// Existing file fills the 2160p bucket only
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-4k',
				movieId: 'movie-1',
				relativePath: 'Test Movie (2026)/Test.Movie.2026.2160p.mkv',
				quality: { resolution: '2160p' }
			})
			.run();

		const result = await mediaOccupancyService.check(
			{ type: 'movie', movieId: 'movie-1' },
			{ candidateResolution: '1080p' }
		);

		expect(result.occupied).toBe(false);
	});

	it('blocks a non-upgrade grab for an already-filled bucket in multi-quality mode', async () => {
		insertMovie({ desiredQualities: ['2160p', '1080p'] });
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-4k',
				movieId: 'movie-1',
				relativePath: 'Test Movie (2026)/Test.Movie.2026.2160p.mkv',
				quality: { resolution: '2160p' }
			})
			.run();

		const result = await mediaOccupancyService.check(
			{ type: 'movie', movieId: 'movie-1' },
			{ candidateResolution: '2160p' }
		);

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('movie_already_has_file');
	});

	it('blocks a non-upgrade grab for a resolution outside the desired buckets', async () => {
		insertMovie({ desiredQualities: ['2160p', '1080p'] });
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-4k',
				movieId: 'movie-1',
				relativePath: 'Test Movie (2026)/Test.Movie.2026.2160p.mkv',
				quality: { resolution: '2160p' }
			})
			.run();

		const result = await mediaOccupancyService.check(
			{ type: 'movie', movieId: 'movie-1' },
			{ candidateResolution: '720p' }
		);

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('movie_already_has_file');
	});

	it('still blocks a single-quality movie with an existing file', async () => {
		insertMovie({ hasFile: true });
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-1',
				movieId: 'movie-1',
				relativePath: 'Test Movie (2026)/Test.Movie.2026.mkv',
				quality: { resolution: '1080p' }
			})
			.run();

		const result = await mediaOccupancyService.check(
			{ type: 'movie', movieId: 'movie-1' },
			{ candidateResolution: '2160p' }
		);

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('movie_already_has_file');
	});

	describe('multi-quality active-download bucket isolation', () => {
		it('does not block a different resolution bucket when another is downloading', async () => {
			insertDownloadClient();
			insertMovie({ desiredQualities: ['2160p', '1080p'] });
			testDb.db
				.insert(downloadQueue)
				.values({
					id: 'queue-1',
					downloadClientId: 'client-1',
					downloadId: 'remote-1',
					title: 'Test.Movie.2026.2160p',
					movieId: 'movie-1',
					status: 'queued',
					protocol: 'torrent',
					quality: { resolution: '2160p' }
				})
				.run();

			const result = await mediaOccupancyService.check(
				{ type: 'movie', movieId: 'movie-1' },
				{ candidateResolution: '1080p' }
			);

			expect(result).toEqual({ occupied: false });
		});

		it('still blocks the resolution bucket that is already downloading', async () => {
			insertDownloadClient();
			insertMovie({ desiredQualities: ['2160p', '1080p'] });
			testDb.db
				.insert(downloadQueue)
				.values({
					id: 'queue-1',
					downloadClientId: 'client-1',
					downloadId: 'remote-1',
					title: 'Test.Movie.2026.2160p',
					movieId: 'movie-1',
					status: 'queued',
					protocol: 'torrent',
					quality: { resolution: '2160p' }
				})
				.run();

			const result = await mediaOccupancyService.check(
				{ type: 'movie', movieId: 'movie-1' },
				{ candidateResolution: '2160p' }
			);

			expect(result.occupied).toBe(true);
			expect(result.reason).toBe('movie_already_downloading');
		});

		it('does not block a bucket when an active download has no parseable resolution', async () => {
			insertDownloadClient();
			insertMovie({ desiredQualities: ['2160p', '1080p'] });
			testDb.db
				.insert(downloadQueue)
				.values({
					id: 'queue-1',
					downloadClientId: 'client-1',
					downloadId: 'remote-1',
					title: 'Test.Movie.2026',
					movieId: 'movie-1',
					status: 'queued',
					protocol: 'torrent'
				})
				.run();

			const result = await mediaOccupancyService.check(
				{ type: 'movie', movieId: 'movie-1' },
				{ candidateResolution: '1080p' }
			);

			expect(result).toEqual({ occupied: false });
		});
	});

	it('marks active episode queue items occupied for an upgrade check', async () => {
		insertDownloadClient();
		insertSeriesEpisode({ hasFile: true });
		testDb.db
			.insert(downloadQueue)
			.values({
				id: 'queue-1',
				downloadClientId: 'client-1',
				downloadId: 'remote-1',
				title: 'Test.Series.S01E01.2160p',
				seriesId: 'series-1',
				episodeIds: ['episode-1'],
				seasonNumber: 1,
				status: 'downloading',
				protocol: 'torrent'
			})
			.run();

		const result = await mediaOccupancyService.check(
			{ type: 'episode', seriesId: 'series-1', episodeId: 'episode-1' },
			{ isUpgrade: true }
		);

		expect(result.occupied).toBe(true);
		expect(result.reason).toBe('episode_already_downloading');
	});

	it('serializes exclusive work for overlapping episode targets', async () => {
		let releaseFirstTask!: () => void;
		const firstTaskStarted = vi.fn();
		const secondTaskStarted = vi.fn();
		const firstTaskCanFinish = new Promise<void>((resolve) => {
			releaseFirstTask = resolve;
		});

		const firstTask = mediaOccupancyService.runExclusive(
			{
				type: 'season',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeIds: ['episode-1', 'episode-2']
			},
			async () => {
				firstTaskStarted();
				await firstTaskCanFinish;
				return 'first';
			}
		);

		const secondTask = mediaOccupancyService.runExclusive(
			{ type: 'episode', seriesId: 'series-1', episodeId: 'episode-2' },
			async () => {
				secondTaskStarted();
				return 'second';
			}
		);

		await Promise.resolve();

		expect(firstTaskStarted).toHaveBeenCalledTimes(1);
		expect(secondTaskStarted).not.toHaveBeenCalled();

		releaseFirstTask();

		await expect(firstTask).resolves.toBe('first');
		await expect(secondTask).resolves.toBe('second');
		expect(secondTaskStarted).toHaveBeenCalledTimes(1);
	});

	it('allows exclusive work for unrelated targets to run concurrently', async () => {
		let releaseFirstTask!: () => void;
		const firstTaskStarted = vi.fn();
		const secondTaskStarted = vi.fn();
		const firstTaskCanFinish = new Promise<void>((resolve) => {
			releaseFirstTask = resolve;
		});

		const firstTask = mediaOccupancyService.runExclusive(
			{ type: 'movie', movieId: 'movie-1' },
			async () => {
				firstTaskStarted();
				await firstTaskCanFinish;
				return 'first';
			}
		);

		const secondTask = mediaOccupancyService.runExclusive(
			{ type: 'episode', seriesId: 'series-1', episodeId: 'episode-1' },
			async () => {
				secondTaskStarted();
				return 'second';
			}
		);

		await Promise.resolve();

		expect(firstTaskStarted).toHaveBeenCalledTimes(1);
		expect(secondTaskStarted).toHaveBeenCalledTimes(1);

		releaseFirstTask();

		await expect(firstTask).resolves.toBe('first');
		await expect(secondTask).resolves.toBe('second');
	});
});

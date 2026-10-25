/**
 * Multi-quality bucket search tests for MonitoringSearchService.
 *
 * Uses a real in-memory DB (createTestDb) per AGENTS.md guidance and mocks only
 * the external collaborators (IndexerManager, GrabService, AlternateTitleService).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import { movies, movieFiles } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createSearchRelease, createGrabResponse } from '../../../../test/fixtures/releases.js';

const testDb: TestDatabase = createTestDb();

// Real DB backing the service and the resolver.
vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

const searchEnhancedMock = vi.hoisted(() => vi.fn());
const grabMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: vi.fn(async () => ({ searchEnhanced: searchEnhancedMock }))
}));

vi.mock('#lib/server/downloads/GrabService.js', () => ({
	grabService: { grab: grabMock }
}));

vi.mock('#lib/server/services/AlternateTitleService.js', () => ({
	getMovieSearchTitles: vi.fn().mockResolvedValue([]),
	getSeriesSearchTitles: vi.fn().mockResolvedValue([])
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {}
	}),
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	}
}));

const { MonitoringSearchService } = await import('./MonitoringSearchService.js');

type Testable = {
	searchMissingMovieQualityBuckets: (
		signal?: AbortSignal,
		options?: { ignoreCooldown?: boolean; cooldownHours?: number }
	) => Promise<unknown[]>;
	searchMovieQualityBucketUpgrades: (
		movie: unknown,
		existingFiles: unknown[],
		effective: string[],
		options: { signal?: AbortSignal; ignoreCooldown?: boolean; cooldownHours?: number }
	) => Promise<unknown[]>;
};

function insertMovie(overrides: Partial<typeof movies.$inferInsert> = {}) {
	const id = overrides.id ?? 'movie-1';
	testDb.db
		.insert(movies)
		.values({
			id,
			tmdbId: overrides.tmdbId ?? 100,
			title: 'Test Movie',
			path: 'Test Movie (2026)',
			monitored: true,
			hasFile: true,
			...overrides
		})
		.run();
	return id;
}

function insertMovieFile(movieId: string, id: string, resolution: string) {
	testDb.db
		.insert(movieFiles)
		.values({
			id,
			movieId,
			relativePath: `Test Movie (2026)/movie.${resolution}.mkv`,
			quality: { resolution }
		})
		.run();
}

describe('MonitoringSearchService multi-quality bucket search', () => {
	let service: Testable;

	beforeAll(() => {
		service = new MonitoringSearchService() as unknown as Testable;
	});
	afterAll(() => {
		destroyTestDb(testDb);
	});
	beforeEach(() => {
		testDb.sqlite.exec(
			'DELETE FROM acquisition_reservations; DELETE FROM acquisition_intents; DELETE FROM movie_files; DELETE FROM movies;'
		);
		searchEnhancedMock.mockReset();
		grabMock.mockReset();
		grabMock.mockResolvedValue(createGrabResponse());
	});

	it('grabs a release for an unfilled bucket in multi-quality mode', async () => {
		const movieId = insertMovie({ desiredQualities: ['2160p', '1080p'] });
		insertMovieFile(movieId, 'file-4k', '2160p'); // 1080p bucket unfilled

		searchEnhancedMock.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'Movie.1080p',
					totalScore: 200,
					parsed: { resolution: '1080p' }
				}),
				createSearchRelease({
					title: 'Movie.720p',
					totalScore: 300,
					parsed: { resolution: '720p' }
				})
			],
			rejections: []
		});

		const results = await service.searchMissingMovieQualityBuckets(undefined, {
			ignoreCooldown: true
		});

		expect(results).toHaveLength(1);
		expect(grabMock).toHaveBeenCalledTimes(1);
		// Must grab the 1080p release (desired unfilled bucket), never the 720p
		expect(grabMock.mock.calls[0][0].release.title).toBe('Movie.1080p');
	});

	it('does not grab when all desired buckets are already filled', async () => {
		const movieId = insertMovie({ desiredQualities: ['2160p', '1080p'] });
		insertMovieFile(movieId, 'file-4k', '2160p');
		insertMovieFile(movieId, 'file-1080', '1080p');

		searchEnhancedMock.mockResolvedValue({
			releases: [createSearchRelease({ parsed: { resolution: '1080p' } })],
			rejections: []
		});

		await service.searchMissingMovieQualityBuckets(undefined, { ignoreCooldown: true });

		expect(grabMock).not.toHaveBeenCalled();
	});

	it('ignores movies that are not in multi-quality mode', async () => {
		// Fewer than 2 effective buckets -> single-quality, not processed here
		insertMovie({ desiredQualities: ['2160p'] });
		insertMovieFile('movie-1', 'file-4k', '2160p');

		searchEnhancedMock.mockResolvedValue({
			releases: [createSearchRelease({ parsed: { resolution: '1080p' } })],
			rejections: []
		});

		await service.searchMissingMovieQualityBuckets(undefined, { ignoreCooldown: true });

		expect(searchEnhancedMock).not.toHaveBeenCalled();
		expect(grabMock).not.toHaveBeenCalled();
	});

	it('upgrades a filled bucket with a within-tier candidate and passes isUpgrade', async () => {
		const movieId = insertMovie({ desiredQualities: ['2160p', '1080p'] });
		insertMovieFile(movieId, 'file-4k', '2160p');

		searchEnhancedMock.mockResolvedValue({
			releases: [
				createSearchRelease({
					title: 'Movie.2160p.REMUX',
					totalScore: 500,
					parsed: { resolution: '2160p' }
				})
			],
			rejections: []
		});

		const rows = testDb.db.select().from(movies).where(eq(movies.id, movieId)).all();
		const movie = rows[0];
		const files = testDb.db.select().from(movieFiles).where(eq(movieFiles.movieId, movieId)).all();

		const results = await service.searchMovieQualityBucketUpgrades(
			movie,
			files,
			['2160p', '1080p'],
			{ ignoreCooldown: true }
		);

		expect(results).toHaveLength(1);
		expect(grabMock).toHaveBeenCalledTimes(1);
		expect(grabMock.mock.calls[0][0].options.isUpgrade).toBe(true);
		expect(grabMock.mock.calls[0][0].release.title).toBe('Movie.2160p.REMUX');
	});
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { api, type ErrorResponse } from '../../../../test/api-helper';
import { movies, episodes, series } from '#lib/server/db/schema.js';

const downloadForMovieMock = vi.hoisted(() => vi.fn());
const downloadForEpisodeMock = vi.hoisted(() => vi.fn());
const emitMovieUpdatedMock = vi.hoisted(() => vi.fn());
const emitSeriesUpdatedMock = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

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

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('#lib/server/subtitles/services/SubtitleDownloadService.js', () => ({
	getSubtitleDownloadService: () => ({
		downloadForMovie: downloadForMovieMock,
		downloadForEpisode: downloadForEpisodeMock
	})
}));

vi.mock('#lib/server/library/LibraryMediaEvents.js', () => ({
	libraryMediaEvents: {
		emitMovieUpdated: emitMovieUpdatedMock,
		emitSeriesUpdated: emitSeriesUpdatedMock
	}
}));

const { POST } = await import('./+server');

const MOVIE_ID = '1a3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';
const EPISODE_ID = '2b3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';
const SERIES_ID = '3c3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';
const PROVIDER_ID = '4d3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';
const MOVIE_FILE_ID = '5e3d9ab6-9bd5-4c40-b8a5-9e035fbaeb49';

const FULL_RESULT = {
	providerId: PROVIDER_ID,
	providerName: 'BetaSeries',
	providerSubtitleId: '55',
	language: 'fr',
	title: 'Show S01E02',
	releaseName: 'Show.S01E02.FR',
	fileName: 'Show.S01E02.FR.srt',
	format: 'srt' as const,
	isHashMatch: true,
	matchScore: 88,
	downloadUrl: 'https://betaseries.test/subtitles/55.srt',
	pageLink: 'https://betaseries.test/subtitles/55',
	movieFileId: MOVIE_FILE_ID,
	downloadCount: 3
};

describe('Subtitle Download API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(async () => {
		clearTestDb(testDb);
		downloadForMovieMock.mockReset();
		downloadForEpisodeMock.mockReset();
		emitMovieUpdatedMock.mockReset();
		emitSeriesUpdatedMock.mockReset();

		await testDb.db.insert(movies).values({
			id: MOVIE_ID,
			tmdbId: 101,
			title: 'Test Movie',
			path: 'Test Movie (2024)'
		});
		await testDb.db.insert(series).values({
			id: SERIES_ID,
			tmdbId: 501,
			title: 'Test Show',
			path: 'Test Show'
		});
		await testDb.db.insert(episodes).values({
			id: EPISODE_ID,
			seriesId: SERIES_ID,
			seasonNumber: 1,
			episodeNumber: 2
		});
	});

	it('forwards the full selected result (including download URL) to the movie download service', async () => {
		downloadForMovieMock.mockResolvedValue({
			subtitleId: 'downloaded-subtitle',
			language: 'fr',
			format: 'srt',
			wasSynced: false,
			syncOffset: null,
			wasUpgrade: false
		});

		const { status, data } = await api.post<{ success: boolean }>(POST, {
			...FULL_RESULT,
			movieId: MOVIE_ID
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(downloadForMovieMock).toHaveBeenCalledWith(
			MOVIE_ID,
			expect.objectContaining({
				providerId: PROVIDER_ID,
				providerName: 'BetaSeries',
				providerSubtitleId: '55',
				language: 'fr',
				title: 'Show S01E02',
				releaseName: 'Show.S01E02.FR',
				fileName: 'Show.S01E02.FR.srt',
				format: 'srt',
				isHashMatch: true,
				matchScore: 88,
				downloadUrl: 'https://betaseries.test/subtitles/55.srt',
				pageLink: 'https://betaseries.test/subtitles/55',
				movieFileId: MOVIE_FILE_ID
			})
		);
		expect(emitMovieUpdatedMock).toHaveBeenCalledWith(MOVIE_ID);
	});

	it('forwards the full selected result to the episode download service and emits series update', async () => {
		downloadForEpisodeMock.mockResolvedValue({
			subtitleId: 'downloaded-subtitle',
			language: 'fr',
			format: 'srt',
			wasSynced: false,
			syncOffset: null,
			wasUpgrade: false
		});

		const { status, data } = await api.post<{ success: boolean }>(POST, {
			...FULL_RESULT,
			episodeId: EPISODE_ID
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(downloadForEpisodeMock).toHaveBeenCalledWith(
			EPISODE_ID,
			expect.objectContaining({
				downloadUrl: 'https://betaseries.test/subtitles/55.srt',
				pageLink: 'https://betaseries.test/subtitles/55',
				providerName: 'BetaSeries'
			})
		);
		expect(emitSeriesUpdatedMock).toHaveBeenCalledWith(SERIES_ID);
	});

	it('rejects an incomplete payload with a validation error', async () => {
		const { status, data } = await api.post<ErrorResponse>(POST, {
			providerId: PROVIDER_ID,
			providerSubtitleId: '55',
			language: 'fr',
			movieId: MOVIE_ID
		});

		expect(status).toBe(400);
		expect(data.error).toBe('Validation failed');
		expect(downloadForMovieMock).not.toHaveBeenCalled();
	});

	it('rejects a payload whose matchScore is off the normalized 0-100 scale', async () => {
		const { status } = await api.post<ErrorResponse>(POST, {
			...FULL_RESULT,
			matchScore: 210,
			movieId: MOVIE_ID
		});

		expect(status).toBe(400);
		expect(downloadForMovieMock).not.toHaveBeenCalled();
	});

	it('requires either movieId or episodeId', async () => {
		const { status, data } = await api.post<ErrorResponse>(POST, FULL_RESULT);

		expect(status).toBe(400);
		expect(data.error).toBe('Either movieId or episodeId is required');
	});
});

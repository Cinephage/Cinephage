import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	movies,
	series,
	episodes,
	subtitles,
	subtitleHistory,
	monitoringHistory,
	languageProfiles
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

const { searchService, downloadService, providerManager, profileService, missingEpisodesBySeries } =
	vi.hoisted(() => {
		const searchService = {
			searchForMovie: vi.fn().mockResolvedValue({ results: [] }),
			searchForEpisode: vi.fn().mockResolvedValue({ results: [] })
		};

		const downloadService = {
			downloadForMovie: vi.fn().mockResolvedValue(undefined),
			downloadForEpisode: vi.fn().mockResolvedValue(undefined)
		};

		const providerManager = {
			getHealthStatus: vi.fn().mockResolvedValue([
				{
					providerName: 'TestProvider',
					isThrottled: false,
					isHealthy: true,
					throttledUntil: null,
					throttleErrorType: null,
					consecutiveFailures: 0,
					lastError: null
				}
			]),
			getEnabledProviders: vi.fn().mockResolvedValue([{ name: 'TestProvider' }])
		};

		// v2 profile shape (LanguageProfileRow) — the tasks consume the
		// subtitles requirements directly (no legacy adapter anymore).
		const defaultProfile = {
			id: 'profile-1',
			name: 'Default',
			audio: { preferOriginal: true, languages: [], mode: 'prefer' },
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			cutoffRank: 0,
			upgradesAllowed: true,
			minimumScore: 80
		};

		const defaultStatus = {
			satisfied: false,
			missing: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			existing: []
		};

		const missingEpisodesBySeries = new Map<string, string[]>();

		const profileService = {
			getDefaultProfile: vi.fn().mockResolvedValue(defaultProfile),
			getProfile: vi.fn().mockResolvedValue(defaultProfile),
			getEffectiveSubtitleRequirements: vi.fn(async () => {
				const profile = await profileService.getProfile();
				return {
					requirements: profile.subtitles,
					source: 'default',
					profile,
					cutoffApplies: true
				};
			}),
			getEffectiveProfileForMovie: vi
				.fn()
				.mockResolvedValue({ profile: defaultProfile, source: 'movie' }),
			getEffectiveProfileForSeries: vi
				.fn()
				.mockResolvedValue({ profile: defaultProfile, source: 'series' }),
			getMovieSubtitleStatus: vi.fn().mockResolvedValue(defaultStatus),
			getEpisodeSubtitleStatus: vi.fn().mockResolvedValue(defaultStatus),
			getSeriesEpisodesMissingSubtitles: vi.fn(
				async (seriesId: string) => missingEpisodesBySeries.get(seriesId) ?? []
			)
		};

		return {
			searchService,
			downloadService,
			providerManager,
			profileService,
			missingEpisodesBySeries
		};
	});

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

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('#lib/server/subtitles/services/SubtitleSearchService.js', () => ({
	getSubtitleSearchService: () => searchService
}));

vi.mock('#lib/server/subtitles/services/SubtitleDownloadService.js', () => ({
	getSubtitleDownloadService: () => downloadService
}));

vi.mock('#lib/server/subtitles/services/SubtitleProviderManager.js', () => ({
	getSubtitleProviderManager: () => providerManager
}));

vi.mock('#lib/server/subtitles/services/LanguageProfileService.js', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#lib/server/subtitles/services/LanguageProfileService.js')
		>();
	return {
		...actual,
		LanguageProfileService: {
			getInstance: () => profileService
		}
	};
});

const { executeMissingSubtitlesTask } = await import('./MissingSubtitlesTask.js');
const { executeSubtitleUpgradeTask } = await import('./SubtitleUpgradeTask.js');

function resetDb() {
	testDb.db.delete(subtitleHistory).run();
	testDb.db.delete(monitoringHistory).run();
	testDb.db.delete(subtitles).run();
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(languageProfiles).run();
	// Migration 137 added a real FK from movies/series.language_profile_id to
	// language_profiles.id, so the profile the tests assign must exist (v2 shape).
	testDb.db
		.insert(languageProfiles)
		.values({
			id: 'profile-1',
			name: 'Default',
			audio: { preferOriginal: true, languages: [], mode: 'prefer' },
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			cutoffRank: 0,
			minimumScore: 80,
			upgradesAllowed: true
		})
		.run();
}

beforeEach(() => {
	resetDb();
	vi.clearAllMocks();
	missingEpisodesBySeries.clear();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('MissingSubtitlesTask monitored gating', () => {
	it('skips unmonitored movies and episodes', async () => {
		const monitoredMovieId = 'movie-monitored';
		const unmonitoredMovieId = 'movie-unmonitored';

		await testDb.db.insert(movies).values([
			{
				id: monitoredMovieId,
				tmdbId: 1,
				title: 'Monitored Movie',
				path: '/movies/monitored',
				hasFile: true,
				wantsSubtitles: true,
				monitored: true,
				languageProfileId: 'profile-1'
			},
			{
				id: unmonitoredMovieId,
				tmdbId: 2,
				title: 'Unmonitored Movie',
				path: '/movies/unmonitored',
				hasFile: true,
				wantsSubtitles: true,
				monitored: false,
				languageProfileId: 'profile-1'
			}
		]);

		const monitoredSeriesId = 'series-monitored';
		const unmonitoredSeriesId = 'series-unmonitored';

		await testDb.db.insert(series).values([
			{
				id: monitoredSeriesId,
				tmdbId: 101,
				title: 'Monitored Series',
				path: '/series/monitored',
				monitored: true,
				wantsSubtitles: true,
				languageProfileId: 'profile-1'
			},
			{
				id: unmonitoredSeriesId,
				tmdbId: 102,
				title: 'Unmonitored Series',
				path: '/series/unmonitored',
				monitored: false,
				wantsSubtitles: true,
				languageProfileId: 'profile-1'
			}
		]);

		const monitoredEpisodeId = 'ep-monitored';
		const unmonitoredEpisodeId = 'ep-unmonitored';
		const unmonitoredSeriesEpisodeId = 'ep-unmonitored-series';

		await testDb.db.insert(episodes).values([
			{
				id: monitoredEpisodeId,
				seriesId: monitoredSeriesId,
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: true,
				monitored: true
			},
			{
				id: unmonitoredEpisodeId,
				seriesId: monitoredSeriesId,
				seasonNumber: 1,
				episodeNumber: 2,
				hasFile: true,
				monitored: false
			},
			{
				id: unmonitoredSeriesEpisodeId,
				seriesId: unmonitoredSeriesId,
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: true,
				monitored: true
			}
		]);

		missingEpisodesBySeries.set(monitoredSeriesId, [monitoredEpisodeId, unmonitoredEpisodeId]);
		missingEpisodesBySeries.set(unmonitoredSeriesId, [unmonitoredSeriesEpisodeId]);

		const result = await executeMissingSubtitlesTask(null);

		expect(result.itemsProcessed).toBe(2);
		expect(searchService.searchForMovie).toHaveBeenCalledTimes(1);
		expect(searchService.searchForMovie).toHaveBeenCalledWith(
			monitoredMovieId,
			['en'],
			expect.objectContaining({ requireHearingImpaired: false })
		);
		expect(
			searchService.searchForMovie.mock.calls.some((call) => call[0] === unmonitoredMovieId)
		).toBe(false);

		expect(searchService.searchForEpisode).toHaveBeenCalledTimes(1);
		expect(searchService.searchForEpisode).toHaveBeenCalledWith(
			monitoredEpisodeId,
			['en'],
			expect.objectContaining({ requireHearingImpaired: false })
		);
		expect(
			searchService.searchForEpisode.mock.calls.some(
				(call) => call[0] === unmonitoredEpisodeId || call[0] === unmonitoredSeriesEpisodeId
			)
		).toBe(false);

		expect(profileService.getSeriesEpisodesMissingSubtitles).toHaveBeenCalledTimes(1);
		expect(profileService.getSeriesEpisodesMissingSubtitles).toHaveBeenCalledWith(
			monitoredSeriesId
		);
	});

	it('resolves library-level profiles read-only for override-less items', async () => {
		await testDb.db.insert(movies).values({
			id: 'movie-inherit',
			tmdbId: 10,
			title: 'Inheriting Movie',
			path: '/movies/inheriting',
			hasFile: true,
			wantsSubtitles: true,
			monitored: true,
			languageProfileId: null
		});

		// Effective resolution lands on the library level (no per-item override).
		profileService.getEffectiveProfileForMovie.mockResolvedValue({
			profile: {
				id: 'profile-library',
				name: 'Library',
				audio: { preferOriginal: true, languages: [], mode: 'prefer' },
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
				cutoffRank: 0,
				upgradesAllowed: true,
				minimumScore: 80
			},
			source: 'library'
		});

		const result = await executeMissingSubtitlesTask(null);

		expect(result.itemsProcessed).toBe(1);
		expect(searchService.searchForMovie).toHaveBeenCalledWith(
			'movie-inherit',
			['en'],
			expect.objectContaining({ requireHearingImpaired: false })
		);

		// The resolved profile must NOT be persisted as an item override.
		const [row] = testDb.db.select().from(movies).all();
		expect(row.languageProfileId).toBeNull();
	});
});

describe('SubtitleUpgradeTask monitored gating', () => {
	it('skips unmonitored movies, series, and episodes', async () => {
		const monitoredMovieId = 'upgrade-movie-monitored';
		const unmonitoredMovieId = 'upgrade-movie-unmonitored';

		await testDb.db.insert(movies).values([
			{
				id: monitoredMovieId,
				tmdbId: 201,
				title: 'Monitored Movie',
				path: '/movies/upgrade-monitored',
				hasFile: true,
				monitored: true,
				wantsSubtitles: true,
				languageProfileId: 'profile-1'
			},
			{
				id: unmonitoredMovieId,
				tmdbId: 202,
				title: 'Unmonitored Movie',
				path: '/movies/upgrade-unmonitored',
				hasFile: true,
				monitored: false,
				wantsSubtitles: true,
				languageProfileId: 'profile-1'
			}
		]);

		await testDb.db.insert(subtitles).values([
			{
				id: 'sub-movie-monitored',
				movieId: monitoredMovieId,
				relativePath: 'monitored.srt',
				language: 'en',
				format: 'srt',
				matchScore: 50
			},
			{
				id: 'sub-movie-unmonitored',
				movieId: unmonitoredMovieId,
				relativePath: 'unmonitored.srt',
				language: 'en',
				format: 'srt',
				matchScore: 50
			}
		]);

		const monitoredSeriesId = 'upgrade-series-monitored';
		const unmonitoredSeriesId = 'upgrade-series-unmonitored';

		await testDb.db.insert(series).values([
			{
				id: monitoredSeriesId,
				tmdbId: 301,
				title: 'Monitored Series',
				path: '/series/upgrade-monitored',
				monitored: true,
				languageProfileId: 'profile-1'
			},
			{
				id: unmonitoredSeriesId,
				tmdbId: 302,
				title: 'Unmonitored Series',
				path: '/series/upgrade-unmonitored',
				monitored: false,
				languageProfileId: 'profile-1'
			}
		]);

		const monitoredEpisodeId = 'upgrade-ep-monitored';
		const unmonitoredEpisodeId = 'upgrade-ep-unmonitored';
		const unmonitoredSeriesEpisodeId = 'upgrade-ep-unmonitored-series';

		await testDb.db.insert(episodes).values([
			{
				id: monitoredEpisodeId,
				seriesId: monitoredSeriesId,
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: true,
				monitored: true
			},
			{
				id: unmonitoredEpisodeId,
				seriesId: monitoredSeriesId,
				seasonNumber: 1,
				episodeNumber: 2,
				hasFile: true,
				monitored: false
			},
			{
				id: unmonitoredSeriesEpisodeId,
				seriesId: unmonitoredSeriesId,
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: true,
				monitored: true
			}
		]);

		await testDb.db.insert(subtitles).values([
			{
				id: 'sub-ep-monitored',
				episodeId: monitoredEpisodeId,
				relativePath: 'ep-monitored.srt',
				language: 'en',
				format: 'srt',
				matchScore: 50
			},
			{
				id: 'sub-ep-unmonitored',
				episodeId: unmonitoredEpisodeId,
				relativePath: 'ep-unmonitored.srt',
				language: 'en',
				format: 'srt',
				matchScore: 50
			},
			{
				id: 'sub-ep-unmonitored-series',
				episodeId: unmonitoredSeriesEpisodeId,
				relativePath: 'ep-unmonitored-series.srt',
				language: 'en',
				format: 'srt',
				matchScore: 50
			}
		]);

		const result = await executeSubtitleUpgradeTask(null);

		expect(result.itemsProcessed).toBe(2);
		expect(searchService.searchForMovie).toHaveBeenCalledTimes(1);
		expect(searchService.searchForMovie).toHaveBeenCalledWith(
			monitoredMovieId,
			['en'],
			expect.objectContaining({ requireHearingImpaired: false })
		);
		expect(
			searchService.searchForMovie.mock.calls.some((call) => call[0] === unmonitoredMovieId)
		).toBe(false);

		expect(searchService.searchForEpisode).toHaveBeenCalledTimes(1);
		expect(searchService.searchForEpisode).toHaveBeenCalledWith(
			monitoredEpisodeId,
			['en'],
			expect.objectContaining({ requireHearingImpaired: false })
		);
		expect(
			searchService.searchForEpisode.mock.calls.some(
				(call) => call[0] === unmonitoredEpisodeId || call[0] === unmonitoredSeriesEpisodeId
			)
		).toBe(false);
	});
});

describe('HI gating on scheduled/import searches', () => {
	it('MissingSubtitlesTask passes requireHearingImpaired for a require-hi movie', async () => {
		await testDb.db.insert(movies).values({
			id: 'hi-movie',
			tmdbId: 401,
			title: 'HI Movie',
			path: '/movies/hi',
			hasFile: true,
			wantsSubtitles: true,
			monitored: true,
			languageProfileId: 'profile-1'
		});

		profileService.getMovieSubtitleStatus.mockResolvedValueOnce({
			satisfied: false,
			missing: [{ tag: 'en', variant: 'regular', accessibility: 'require-hi' }],
			existing: []
		});

		await executeMissingSubtitlesTask(null);

		expect(searchService.searchForMovie).toHaveBeenCalledWith(
			'hi-movie',
			['en'],
			expect.objectContaining({
				requireHearingImpaired: true,
				minimumScore: 80,
				requirements: [expect.objectContaining({ accessibility: 'require-hi' })]
			})
		);
	});

	it('MissingSubtitlesTask passes requireHearingImpaired for a require-hi episode', async () => {
		const seriesId = 'hi-series';
		const episodeId = 'hi-episode';
		await testDb.db.insert(series).values({
			id: seriesId,
			tmdbId: 402,
			title: 'HI Series',
			path: '/series/hi',
			monitored: true,
			wantsSubtitles: true,
			languageProfileId: 'profile-1'
		});
		await testDb.db.insert(episodes).values({
			id: episodeId,
			seriesId,
			seasonNumber: 1,
			episodeNumber: 1,
			hasFile: true,
			monitored: true
		});
		missingEpisodesBySeries.set(seriesId, [episodeId]);

		profileService.getEpisodeSubtitleStatus.mockResolvedValueOnce({
			satisfied: false,
			missing: [{ tag: 'en', variant: 'regular', accessibility: 'require-hi' }],
			existing: []
		});

		await executeMissingSubtitlesTask(null);

		expect(searchService.searchForEpisode).toHaveBeenCalledWith(
			episodeId,
			['en'],
			expect.objectContaining({
				requireHearingImpaired: true,
				minimumScore: 80,
				requirements: [expect.objectContaining({ accessibility: 'require-hi' })]
			})
		);
	});

	it('SubtitleUpgradeTask passes requireHearingImpaired for a require-hi profile', async () => {
		const movieId = 'hi-upgrade-movie';
		await testDb.db.insert(movies).values({
			id: movieId,
			tmdbId: 403,
			title: 'HI Upgrade Movie',
			path: '/movies/hi-upgrade',
			hasFile: true,
			wantsSubtitles: true,
			monitored: true,
			languageProfileId: 'profile-1'
		});
		await testDb.db.insert(subtitles).values({
			id: 'hi-upgrade-sub',
			movieId,
			relativePath: 'hi-upgrade.srt',
			language: 'en',
			isHearingImpaired: true,
			format: 'srt',
			matchScore: 50
		});

		profileService.getProfile.mockResolvedValueOnce({
			id: 'profile-1',
			name: 'Default',
			audio: { preferOriginal: true, languages: [], mode: 'prefer' },
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'require-hi' }],
			cutoffRank: 0,
			upgradesAllowed: true,
			minimumScore: 80
		});

		await executeSubtitleUpgradeTask(null);

		expect(searchService.searchForMovie).toHaveBeenCalledWith(movieId, ['en'], {
			requireHearingImpaired: true
		});
	});
});

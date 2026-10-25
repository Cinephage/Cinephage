import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { movies, series, episodes, languageProfiles } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

const { searchService, downloadService, profileService } = vi.hoisted(() => {
	const searchService = {
		searchForMovie: vi.fn().mockResolvedValue({ results: [] }),
		searchForEpisode: vi.fn().mockResolvedValue({ results: [] })
	};

	const downloadService = {
		downloadForMovie: vi.fn().mockResolvedValue(undefined),
		downloadForEpisode: vi.fn().mockResolvedValue(undefined)
	};

	const profile = {
		id: 'profile-1',
		name: 'Default',
		audio: { preferOriginal: true, languages: [], mode: 'prefer' },
		subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
		cutoffRank: 0,
		upgradesAllowed: true,
		minimumScore: 80
	};

	const profileService = {
		getDefaultProfile: vi.fn().mockResolvedValue(profile),
		getProfile: vi.fn().mockResolvedValue(profile),
		getEffectiveProfileForMovie: vi.fn().mockResolvedValue({ profile, source: 'movie' }),
		getEffectiveProfileForSeries: vi.fn().mockResolvedValue({ profile, source: 'series' }),
		getEffectiveSubtitleRequirements: vi.fn().mockResolvedValue({
			requirements: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			source: 'movie',
			profile,
			cutoffApplies: true
		}),
		getMovieSubtitleStatus: vi
			.fn()
			.mockResolvedValue({ satisfied: false, missing: [], existing: [] }),
		getEpisodeSubtitleStatus: vi
			.fn()
			.mockResolvedValue({ satisfied: false, missing: [], existing: [] })
	};

	return { searchService, downloadService, profileService };
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

vi.mock('./SubtitleSearchService.js', () => ({
	getSubtitleSearchService: () => searchService
}));

vi.mock('./SubtitleDownloadService.js', () => ({
	getSubtitleDownloadService: () => downloadService
}));

vi.mock('./LanguageProfileService.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./LanguageProfileService.js')>();
	return {
		...actual,
		LanguageProfileService: {
			getInstance: () => profileService
		}
	};
});

vi.mock('#lib/server/monitoring/specifications/MonitoredSpecification.js', () => ({
	isMovieMonitored: vi.fn().mockResolvedValue(true)
}));

const { searchSubtitlesForNewMedia } = await import('./SubtitleImportService.js');

beforeEach(() => {
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(languageProfiles).run();
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
	vi.clearAllMocks();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('SubtitleImportService HI gating', () => {
	it('passes requireHearingImpaired for a movie with a require-hi missing requirement', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'import-hi-movie',
				tmdbId: 501,
				title: 'Import HI Movie',
				path: '/movies/import-hi',
				hasFile: true,
				monitored: true,
				wantsSubtitles: true,
				languageProfileId: 'profile-1'
			})
			.run();

		profileService.getMovieSubtitleStatus.mockResolvedValueOnce({
			satisfied: false,
			missing: [{ tag: 'en', variant: 'regular', accessibility: 'require-hi' }],
			existing: []
		});

		await searchSubtitlesForNewMedia('movie', 'import-hi-movie');

		expect(searchService.searchForMovie).toHaveBeenCalledWith(
			'import-hi-movie',
			['en'],
			expect.objectContaining({
				requireHearingImpaired: true,
				minimumScore: 80,
				requirements: [expect.objectContaining({ accessibility: 'require-hi' })]
			})
		);
	});

	it('passes requireHearingImpaired for an episode with a require-hi missing requirement', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 'import-hi-series',
				tmdbId: 502,
				title: 'Import HI Series',
				path: '/series/import-hi',
				monitored: true,
				wantsSubtitles: true,
				languageProfileId: 'profile-1'
			})
			.run();
		testDb.db
			.insert(episodes)
			.values({
				id: 'import-hi-episode',
				seriesId: 'import-hi-series',
				seasonNumber: 1,
				episodeNumber: 1,
				hasFile: true,
				monitored: true
			})
			.run();

		profileService.getEpisodeSubtitleStatus.mockResolvedValueOnce({
			satisfied: false,
			missing: [{ tag: 'en', variant: 'regular', accessibility: 'require-hi' }],
			existing: []
		});

		await searchSubtitlesForNewMedia('episode', 'import-hi-episode');

		expect(searchService.searchForEpisode).toHaveBeenCalledWith(
			'import-hi-episode',
			['en'],
			expect.objectContaining({
				requireHearingImpaired: true,
				minimumScore: 80,
				requirements: [expect.objectContaining({ accessibility: 'require-hi' })]
			})
		);
	});

	it('does not require HI verification for a non-HI requirement', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'import-plain-movie',
				tmdbId: 503,
				title: 'Import Plain Movie',
				path: '/movies/import-plain',
				hasFile: true,
				monitored: true,
				wantsSubtitles: true,
				languageProfileId: 'profile-1'
			})
			.run();

		profileService.getMovieSubtitleStatus.mockResolvedValueOnce({
			satisfied: false,
			missing: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			existing: []
		});

		await searchSubtitlesForNewMedia('movie', 'import-plain-movie');

		expect(searchService.searchForMovie).toHaveBeenCalledWith(
			'import-plain-movie',
			['en'],
			expect.objectContaining({ requireHearingImpaired: false, minimumScore: 80 })
		);
	});
});

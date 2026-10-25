import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { movies, subtitles, languageProfiles } from '#lib/server/db/schema.js';
import { eq, isNull } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();

const { searchService, downloadService, providerManager, profileService, profileState } =
	vi.hoisted(() => {
		const searchService = {
			searchForMovie: vi.fn().mockResolvedValue({ results: [] }),
			searchForEpisode: vi.fn().mockResolvedValue({ results: [] })
		};
		const downloadService = {
			downloadForMovie: vi.fn().mockResolvedValue({ subtitleId: 'new-sub' }),
			downloadForEpisode: vi.fn().mockResolvedValue({ subtitleId: 'new-sub' })
		};
		const providerManager = {
			getHealthStatus: vi.fn().mockResolvedValue([]),
			getEnabledProviders: vi.fn().mockResolvedValue([{ name: 'TestProvider' }])
		};

		// Mutable so individual tests can pick the requirement tuple.
		const profileState: {
			subtitles: Array<{
				tag: string;
				variant: 'regular' | 'forced' | 'both';
				accessibility: string;
			}>;
		} = {
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }]
		};

		const profileService = {
			getDefaultProfile: vi.fn(),
			getProfile: vi.fn(async () => ({
				id: 'profile-1',
				name: 'Default',
				audio: { preferOriginal: true, languages: [], mode: 'prefer' },
				subtitles: profileState.subtitles,
				cutoffRank: null,
				minimumScore: 70,
				upgradesAllowed: true
			})),
			getEffectiveSubtitleRequirements: vi.fn(async (): Promise<unknown> => ({
				requirements: profileState.subtitles,
				source: 'default',
				profile: await profileServiceMocks.getProfile(),
				cutoffApplies: true
			})),
			getMovieSubtitleStatus: vi.fn(),
			getEpisodeSubtitleStatus: vi.fn(),
			getSeriesEpisodesMissingSubtitles: vi.fn().mockResolvedValue([])
		};
		const profileServiceMocks = { getProfile: profileService.getProfile };

		return { searchService, downloadService, providerManager, profileService, profileState };
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
		LanguageProfileService: { getInstance: () => profileService }
	};
});

const { executeSubtitleUpgradeTask } = await import('./SubtitleUpgradeTask.js');

function resetDb() {
	testDb.db.delete(subtitles).run();
	testDb.db.delete(movies).run();
	testDb.db.delete(languageProfiles).run();
	testDb.db
		.insert(languageProfiles)
		.values({
			id: 'profile-1',
			name: 'Default',
			audio: { preferOriginal: true, languages: [], mode: 'prefer' },
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			cutoffRank: null,
			minimumScore: 70,
			upgradesAllowed: true
		})
		.run();
	profileState.subtitles = [{ tag: 'en', variant: 'regular', accessibility: 'any' }];
}

beforeEach(() => {
	resetDb();
	vi.clearAllMocks();
	searchService.searchForMovie.mockResolvedValue({ results: [] });
	searchService.searchForEpisode.mockResolvedValue({ results: [] });
});

afterAll(() => destroyTestDb(testDb));

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		providerId: 'prov',
		providerName: 'Provider',
		providerSubtitleId: 'cand-1',
		language: 'en',
		title: 'Movie',
		isForced: false,
		isHearingImpaired: false,
		format: 'srt',
		isHashMatch: false,
		matchScore: 95,
		...overrides
	};
}

describe('SubtitleUpgradeTask rotation', () => {
	it('stamps last_checked_at for every row examined and rotates past the cap', async () => {
		const movieRows = Array.from({ length: 55 }, (_, index) => ({
			id: `rot-movie-${index}`,
			tmdbId: 1000 + index,
			title: `Rot Movie ${index}`,
			path: `/movies/rot-${index}`,
			hasFile: true,
			monitored: true,
			wantsSubtitles: true,
			languageProfileId: 'profile-1'
		}));
		await testDb.db.insert(movies).values(movieRows);
		await testDb.db.insert(subtitles).values(
			movieRows.map((movie, index) => ({
				id: `rot-sub-${index}`,
				movieId: movie.id,
				relativePath: `rot-${index}.srt`,
				language: 'en',
				format: 'srt',
				matchScore: 50
			}))
		);

		const first = await executeSubtitleUpgradeTask(null);
		expect(first.itemsProcessed).toBe(50);

		const stampedAfterFirst = testDb.db
			.select({ id: subtitles.id })
			.from(subtitles)
			.where(isNull(subtitles.lastCheckedAt))
			.all();
		// Exactly the 5 rows beyond the LIMIT 50 remain unstamped.
		expect(stampedAfterFirst.length).toBe(5);

		await executeSubtitleUpgradeTask(null);

		const remaining = testDb.db
			.select({ id: subtitles.id })
			.from(subtitles)
			.where(isNull(subtitles.lastCheckedAt))
			.all();
		expect(remaining.length).toBe(0);
	});
});

describe('SubtitleUpgradeTask requirement tuple', () => {
	async function seed(forcedExisting: boolean, profileVariant: 'regular' | 'forced' | 'both') {
		await testDb.db.insert(movies).values({
			id: 'tuple-movie',
			tmdbId: 5001,
			title: 'Tuple Movie',
			path: '/movies/tuple',
			hasFile: true,
			monitored: true,
			wantsSubtitles: true,
			languageProfileId: 'profile-1'
		});
		await testDb.db.insert(subtitles).values({
			id: 'tuple-sub',
			movieId: 'tuple-movie',
			relativePath: 'tuple.srt',
			language: 'en',
			isForced: forcedExisting,
			format: 'srt',
			matchScore: 50
		});
		profileState.subtitles = [{ tag: 'en', variant: profileVariant, accessibility: 'any' }];
	}

	it('rejects a regular candidate upgrading a forced subtitle', async () => {
		await seed(true, 'forced');
		searchService.searchForMovie.mockResolvedValue({ results: [candidate({ isForced: false })] });

		await executeSubtitleUpgradeTask(null);

		expect(downloadService.downloadForMovie).not.toHaveBeenCalled();
	});

	it('rejects a forced candidate upgrading a regular subtitle', async () => {
		await seed(false, 'regular');
		searchService.searchForMovie.mockResolvedValue({ results: [candidate({ isForced: true })] });

		await executeSubtitleUpgradeTask(null);

		expect(downloadService.downloadForMovie).not.toHaveBeenCalled();
	});

	it('accepts a tuple-valid improvement', async () => {
		await seed(true, 'forced');
		searchService.searchForMovie.mockResolvedValue({ results: [candidate({ isForced: true })] });

		const result = await executeSubtitleUpgradeTask(null);

		expect(downloadService.downloadForMovie).toHaveBeenCalledTimes(1);
		expect(result.itemsGrabbed).toBe(1);

		// Rotation stamped the examined row.
		const row = testDb.db.select().from(subtitles).where(eq(subtitles.id, 'tuple-sub')).get();
		expect(row?.lastCheckedAt).toBeTruthy();
	});

	it('skips rows whose subtitle satisfies no profile requirement', async () => {
		await seed(true, 'regular');
		searchService.searchForMovie.mockResolvedValue({ results: [candidate({ isForced: true })] });

		await executeSubtitleUpgradeTask(null);

		expect(downloadService.downloadForMovie).not.toHaveBeenCalled();
	});
});

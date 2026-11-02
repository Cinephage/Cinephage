import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
	autoSearchEpisode,
	autoSearchMovie,
	episodePreflightReason,
	moviePreflightReason,
	summarizeAutoSearchReason
} from './auto-search.js';
import type { MovieLike, EpisodeLike, SeriesLike } from './auto-search.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

const { searchService, downloadService, profileState } = vi.hoisted(() => {
	const searchService = {
		searchForMovie: vi.fn().mockResolvedValue({ results: [] }),
		searchForEpisode: vi.fn().mockResolvedValue({ results: [] })
	};
	const downloadService = {
		downloadForMovie: vi.fn().mockResolvedValue({
			subtitleId: 'sub-new',
			path: '/movies/x/y.srt',
			language: 'en',
			format: 'srt',
			wasSynced: false,
			syncOffset: null,
			wasUpgrade: false
		}),
		downloadForEpisode: vi.fn().mockResolvedValue({
			subtitleId: 'sub-new',
			path: '/tv/x/y.srt',
			language: 'en',
			format: 'srt',
			wasSynced: false,
			syncOffset: null,
			wasUpgrade: false
		})
	};

	const profileState: {
		profile: unknown;
		effective: unknown;
		movieStatus: { satisfied: boolean; missing: SubtitleRequirement[]; existing: [] };
		episodeStatus: { satisfied: boolean; missing: SubtitleRequirement[]; existing: [] };
	} = {
		profile: undefined,
		effective: undefined,
		movieStatus: { satisfied: false, missing: [], existing: [] },
		episodeStatus: { satisfied: false, missing: [], existing: [] }
	};

	return { searchService, downloadService, profileState };
});

vi.mock('./services/SubtitleSearchService.js', () => ({
	getSubtitleSearchService: () => searchService
}));
vi.mock('./services/SubtitleDownloadService.js', () => ({
	getSubtitleDownloadService: () => downloadService
}));
vi.mock('./services/LanguageProfileService.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./services/LanguageProfileService.js')>();
	return {
		...actual,
		LanguageProfileService: {
			getInstance: () => ({
				getProfileForMovie: vi.fn(async () => profileState.profile),
				getProfileForSeries: vi.fn(async () => profileState.profile),
				getEffectiveSubtitleRequirements: vi.fn(async () => profileState.effective),
				getMovieSubtitleStatus: vi.fn(async () => profileState.movieStatus),
				getEpisodeSubtitleStatus: vi.fn(async () => profileState.episodeStatus)
			})
		}
	};
});

vi.mock('#lib/logging/index.js', () => {
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return { createChildLogger: vi.fn(() => logger) };
});

const requirement: SubtitleRequirement = { tag: 'en', variant: 'regular', accessibility: 'any' };

function profile() {
	return {
		id: 'profile-1',
		name: 'Default',
		audio: { preferOriginal: true, languages: [] },
		subtitles: [requirement],
		cutoffRank: null,
		minimumScore: 70,
		upgradesAllowed: true
	};
}

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		providerId: 'prov',
		providerName: 'Provider',
		providerSubtitleId: 'c1',
		language: 'en',
		title: 'Movie',
		isForced: false,
		isHearingImpaired: false,
		format: 'srt',
		isHashMatch: false,
		matchScore: 90,
		...overrides
	};
}

const baseMovie: MovieLike = {
	id: 'movie-1',
	title: 'Movie',
	hasFile: true,
	monitored: true,
	wantsSubtitles: true
};

const baseEpisode: EpisodeLike = {
	id: 'ep-1',
	seriesId: 'series-1',
	seasonNumber: 1,
	episodeNumber: 1,
	title: 'Episode',
	hasFile: true,
	monitored: true,
	wantsSubtitlesOverride: null
};

const baseSeries: SeriesLike = { id: 'series-1', monitored: true, wantsSubtitles: true };

beforeAll(async () => {
	// autoSearchMovie/autoSearchEpisode always record outcomes via
	// subtitle-search-state.js, which hits the real singleton db (unmocked).
	// Ensure its schema is synced before any test in this file runs — CI runs
	// from a fresh, unmigrated database.
	const { initializeDatabase } = await import('#lib/server/db/index.js');
	await initializeDatabase();
});

beforeEach(() => {
	vi.clearAllMocks();
	profileState.profile = profile();
	profileState.effective = {
		requirements: [requirement],
		source: 'instance',
		profile: profile(),
		cutoffApplies: true
	};
	profileState.movieStatus = { satisfied: false, missing: [requirement], existing: [] };
	profileState.episodeStatus = { satisfied: false, missing: [requirement], existing: [] };
	searchService.searchForMovie.mockResolvedValue({ results: [] });
	searchService.searchForEpisode.mockResolvedValue({ results: [] });
});

describe('preflight reasons', () => {
	it('maps movie preflight in priority order', () => {
		expect(moviePreflightReason({ ...baseMovie, hasFile: false })).toBe('no_file');
		expect(moviePreflightReason({ ...baseMovie, monitored: false })).toBe('not_monitored');
		expect(moviePreflightReason({ ...baseMovie, wantsSubtitles: false })).toBe('opted_out');
		expect(moviePreflightReason(baseMovie)).toBeNull();
	});

	it('maps episode preflight including series flags', () => {
		expect(episodePreflightReason({ ...baseEpisode, hasFile: false }, baseSeries)).toBe('no_file');
		expect(episodePreflightReason({ ...baseEpisode, monitored: false }, baseSeries)).toBe(
			'not_monitored'
		);
		expect(episodePreflightReason(baseEpisode, { ...baseSeries, monitored: false })).toBe(
			'not_monitored'
		);
		expect(
			episodePreflightReason({ ...baseEpisode, wantsSubtitlesOverride: false }, baseSeries)
		).toBe('opted_out');
		expect(episodePreflightReason(baseEpisode, { ...baseSeries, wantsSubtitles: false })).toBe(
			'opted_out'
		);
		expect(episodePreflightReason(baseEpisode, baseSeries)).toBeNull();
	});
});

describe('autoSearchMovie outcomes', () => {
	it('skips when preflight fails without searching', async () => {
		const result = await autoSearchMovie({ ...baseMovie, hasFile: false });

		expect(result.skipped).toBe('no_file');
		expect(result.searched).toBe(false);
		expect(searchService.searchForMovie).not.toHaveBeenCalled();
		expect(summarizeAutoSearchReason(result)).toBe('no_file');
	});

	it('reports no_profile when no profile resolves', async () => {
		profileState.profile = undefined;
		profileState.effective = null;
		const result = await autoSearchMovie(baseMovie);

		expect(result.skipped).toBe('no_profile');
		expect(searchService.searchForMovie).not.toHaveBeenCalled();
	});

	it('reports satisfied when nothing is missing', async () => {
		profileState.movieStatus = { satisfied: true, missing: [], existing: [] };
		const result = await autoSearchMovie(baseMovie);

		expect(result.searched).toBe(false);
		expect(result.outcomes).toEqual([]);
		expect(summarizeAutoSearchReason(result)).toBe('satisfied');
	});

	it('reserves no_results for genuinely zero provider results', async () => {
		searchService.searchForMovie.mockResolvedValue({ results: [] });
		const result = await autoSearchMovie(baseMovie);

		expect(result.searched).toBe(true);
		expect(result.outcomes).toHaveLength(1);
		expect(result.outcomes[0].reason).toBe('no_results');
		expect(summarizeAutoSearchReason(result)).toBe('no_results');
	});

	it('reports below_threshold with the rejected score and reason (requirement)', async () => {
		searchService.searchForMovie.mockResolvedValue({
			results: [candidate({ isForced: true, matchScore: 99 })]
		});
		const result = await autoSearchMovie(baseMovie);

		expect(result.downloaded).toBe(0);
		expect(result.outcomes[0].reason).toBe('below_threshold');
		expect(result.outcomes[0].bestRejectedScore).toBe(99);
		expect(result.outcomes[0].bestRejectedReason).toBe('requirement');
	});

	it('reports below_threshold with the rejected score and reason (threshold)', async () => {
		searchService.searchForMovie.mockResolvedValue({ results: [candidate({ matchScore: 55 })] });
		const result = await autoSearchMovie(baseMovie);

		expect(result.outcomes[0].reason).toBe('below_threshold');
		expect(result.outcomes[0].bestRejectedScore).toBe(55);
		expect(result.outcomes[0].bestRejectedReason).toBe('threshold');
	});

	it('downloads a tuple-valid candidate above threshold', async () => {
		searchService.searchForMovie.mockResolvedValue({ results: [candidate({ matchScore: 85 })] });
		const result = await autoSearchMovie(baseMovie);

		expect(result.downloaded).toBe(1);
		expect(result.outcomes[0].reason).toBe('downloaded');
		expect(result.outcomes[0].matchScore).toBe(85);
		expect(result.subtitle?.subtitleId).toBe('sub-new');
		expect(summarizeAutoSearchReason(result)).toBe('downloaded');
	});

	it('reports error when the download throws', async () => {
		searchService.searchForMovie.mockResolvedValue({ results: [candidate()] });
		downloadService.downloadForMovie.mockRejectedValueOnce(new Error('disk full'));
		const result = await autoSearchMovie(baseMovie);

		expect(result.downloaded).toBe(0);
		expect(result.outcomes[0].reason).toBe('error');
		expect(result.outcomes[0].error).toBe('disk full');
	});
});

describe('per-item override awareness', () => {
	it('queries providers with override requirement languages, not the profile chain', async () => {
		const fr: SubtitleRequirement = { tag: 'fr', variant: 'regular', accessibility: 'any' };
		profileState.effective = {
			requirements: [fr],
			source: 'movie',
			profile: profile(), // chain profile only lists English
			cutoffApplies: false
		};
		profileState.movieStatus = { satisfied: false, missing: [fr], existing: [] };
		searchService.searchForMovie.mockResolvedValue({
			results: [candidate({ language: 'fr', matchScore: 85 })]
		});

		const result = await autoSearchMovie(baseMovie);

		expect(searchService.searchForMovie).toHaveBeenCalledWith('movie-1', ['fr'], expect.anything());
		expect(result.downloaded).toBe(1);
	});

	it('searches override-only items with no profile chain using the default threshold', async () => {
		const fr: SubtitleRequirement = { tag: 'fr', variant: 'regular', accessibility: 'any' };
		profileState.effective = {
			requirements: [fr],
			source: 'movie',
			profile: null,
			cutoffApplies: false
		};
		profileState.movieStatus = { satisfied: false, missing: [fr], existing: [] };
		searchService.searchForMovie.mockResolvedValue({
			results: [candidate({ language: 'fr', matchScore: 75 })]
		});

		const result = await autoSearchMovie(baseMovie);

		expect(searchService.searchForMovie).toHaveBeenCalledWith('movie-1', ['fr'], expect.anything());
		expect(result.downloaded).toBe(1);
	});

	it('uses episode overrides for episode searches', async () => {
		const fr: SubtitleRequirement = { tag: 'fr', variant: 'regular', accessibility: 'any' };
		profileState.effective = {
			requirements: [fr],
			source: 'episode',
			profile: profile(),
			cutoffApplies: false
		};
		profileState.episodeStatus = { satisfied: false, missing: [fr], existing: [] };
		searchService.searchForEpisode.mockResolvedValue({
			results: [candidate({ language: 'fr', matchScore: 85 })]
		});

		const result = await autoSearchEpisode(baseEpisode, baseSeries);

		expect(searchService.searchForEpisode).toHaveBeenCalledWith('ep-1', ['fr'], expect.anything());
		expect(result.downloaded).toBe(1);
	});
});

describe('autoSearchEpisode outcomes', () => {
	it('skips opted-out episodes without searching', async () => {
		const result = await autoSearchEpisode(
			{ ...baseEpisode, wantsSubtitlesOverride: false },
			baseSeries
		);

		expect(result.skipped).toBe('opted_out');
		expect(searchService.searchForEpisode).not.toHaveBeenCalled();
	});

	it('downloads a tuple-valid candidate', async () => {
		searchService.searchForEpisode.mockResolvedValue({ results: [candidate({ matchScore: 88 })] });
		const result = await autoSearchEpisode(baseEpisode, baseSeries);

		expect(result.downloaded).toBe(1);
		expect(downloadService.downloadForEpisode).toHaveBeenCalledTimes(1);
	});
});

describe('episode wantsSubtitles tri-state gate', () => {
	// baseEpisode has a file and is monitored; baseSeries is monitored.
	const cases: Array<[boolean | null, boolean | undefined, string | null]> = [
		[null, true, null],
		[null, false, 'opted_out'],
		[true, true, null],
		[true, false, null], // force-on against a series-level opt-out
		[false, true, 'opted_out'],
		[false, false, 'opted_out']
	];

	it.each(cases)('override %s + series %s → %s', (override, seriesFlag, expected) => {
		expect(
			episodePreflightReason(
				{ ...baseEpisode, wantsSubtitlesOverride: override },
				{ ...baseSeries, wantsSubtitles: seriesFlag }
			)
		).toBe(expected);
	});
});

describe('requirement-targeted search (Search now)', () => {
	const REQ_EN = { tag: 'en', variant: 'regular' as const, accessibility: 'any' as const };
	const REQ_DE = { tag: 'de', variant: 'regular' as const, accessibility: 'any' as const };

	beforeEach(async () => {
		// State persists across tests in the shared backing DB — start clean.
		const { subtitleSearchState } = await import('#lib/server/db/schema.js');
		const { db } = await import('#lib/server/db/index.js');
		db.delete(subtitleSearchState).run();
		profileState.profile = {
			id: 'p1',
			name: 'P',
			audio: { preferOriginal: true, languages: [] },
			subtitles: [REQ_EN, REQ_DE],
			cutoffRank: null,
			minimumScore: 70,
			upgradesAllowed: true
		};
	});

	it('targets only the requested requirement and records its outcome', async () => {
		profileState.movieStatus = { satisfied: false, missing: [REQ_EN, REQ_DE], existing: [] };
		searchService.searchForMovie.mockResolvedValue({ results: [] });

		const result = await autoSearchMovie(baseMovie, { requirement: REQ_DE });

		// Only the requested requirement appears in outcomes.
		expect(result.outcomes.map((o) => o.tag)).toEqual(['de']);
		expect(result.outcomes[0].reason).toBe('no_results');
		// Manual intent: the requirement's outcome still records backoff state.
		const { getSearchStates } = await import('./subtitle-search-state.js');
		const states = await getSearchStates('movie', baseMovie.id);
		expect(states.get('de|regular|any')?.failedAttempts).toBe(1);
		expect(states.get('en|regular|any')).toBeUndefined();
	});

	it('bypasses a closed backoff window for the targeted requirement', async () => {
		profileState.movieStatus = { satisfied: false, missing: [REQ_EN, REQ_DE], existing: [] };
		const { recordSearchFailure } = await import('./subtitle-search-state.js');
		// Put de deep into the extended backoff window.
		const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
		const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
		await recordSearchFailure('movie', baseMovie.id, 'de|regular|any', old);
		await recordSearchFailure('movie', baseMovie.id, 'de|regular|any', recent);
		searchService.searchForMovie.mockResolvedValue({
			results: [candidate({ language: 'de', matchScore: 90 })]
		});

		const result = await autoSearchMovie(baseMovie, { requirement: REQ_DE });

		// Backoff would have filtered de out for scheduled paths; manual intent searches anyway.
		expect(result.searched).toBe(true);
		expect(result.downloaded).toBe(1);
	});

	it('returns satisfied-style result when the targeted requirement is already met', async () => {
		profileState.movieStatus = { satisfied: false, missing: [REQ_DE], existing: [] };
		const result = await autoSearchMovie(baseMovie, { requirement: REQ_EN });
		expect(result.searched).toBe(false);
		expect(result.outcomes).toEqual([]);
	});
});

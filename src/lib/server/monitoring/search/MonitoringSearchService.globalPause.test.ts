/**
 * The global "pause all automatic search" switch must short-circuit every
 * MonitoringSearchService entry point before any DB query - proven by
 * asserting the DB mock functions are never called, not by their outcome
 * (these methods swallow query errors into their own catch block and
 * return an empty-looking result either way, so a throwing mock can't
 * distinguish "short-circuited" from "crashed").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const isAutoSearchGloballyPausedMock = vi.fn().mockResolvedValue(true);

vi.mock('../global-search-pause.js', () => ({
	isAutoSearchGloballyPaused: isAutoSearchGloballyPausedMock
}));

const findManyMoviesMock = vi.fn().mockResolvedValue([]);
const findManyEpisodesMock = vi.fn().mockResolvedValue([]);
const findManySeriesMock = vi.fn().mockResolvedValue([]);
const selectMock = vi.fn().mockReturnValue({
	from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) })
});

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			movies: { findMany: findManyMoviesMock },
			episodes: { findMany: findManyEpisodesMock },
			series: { findMany: findManySeriesMock }
		},
		select: selectMock
	}
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	createChildLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
}));

const { MonitoringSearchService } = await import('./MonitoringSearchService.js');

beforeEach(() => {
	findManyMoviesMock.mockClear();
	findManyEpisodesMock.mockClear();
	findManySeriesMock.mockClear();
	selectMock.mockClear();
	isAutoSearchGloballyPausedMock.mockClear().mockResolvedValue(true);
});

describe('MonitoringSearchService - global auto-search pause', () => {
	it('short-circuits searchMissingMovies without querying movies', async () => {
		const service = new MonitoringSearchService();
		const result = await service.searchMissingMovies();
		expect(result).toEqual({
			items: [],
			summary: { searched: 0, found: 0, grabbed: 0, skipped: 0, errors: 0 }
		});
		expect(findManyMoviesMock).not.toHaveBeenCalled();
	});

	it('short-circuits searchMissingEpisodes without querying episodes', async () => {
		const service = new MonitoringSearchService();
		await service.searchMissingEpisodes();
		expect(findManyEpisodesMock).not.toHaveBeenCalled();
	});

	it('short-circuits searchForUpgrades without querying movies/episodes', async () => {
		const service = new MonitoringSearchService();
		await service.searchForUpgrades();
		expect(findManyMoviesMock).not.toHaveBeenCalled();
		expect(findManyEpisodesMock).not.toHaveBeenCalled();
	});

	it('does NOT check the global pause for a dry-run upgrade search preview', async () => {
		const service = new MonitoringSearchService();
		await service.searchForUpgrades({ dryRun: true });
		expect(isAutoSearchGloballyPausedMock).not.toHaveBeenCalled();
	});

	it('short-circuits searchNewEpisodes without querying episodes', async () => {
		const service = new MonitoringSearchService();
		await service.searchNewEpisodes(48);
		expect(findManyEpisodesMock).not.toHaveBeenCalled();
	});

	it('does not short-circuit when not globally paused', async () => {
		isAutoSearchGloballyPausedMock.mockResolvedValue(false);
		const service = new MonitoringSearchService();
		await service.searchMissingMovies();
		expect(findManyMoviesMock).toHaveBeenCalled();
	});
});

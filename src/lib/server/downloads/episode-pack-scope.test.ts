import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	seasonEpisodes: [] as Array<{ id: string; episodeNumber: number }>,
	queueRows: [] as Array<{ episodeIds: string[] | null }>,
	failQueries: false,
	warn: vi.fn()
}));

const tables = vi.hoisted(() => ({
	episodes: { __table: 'episodes' },
	downloadQueue: { __table: 'downloadQueue' }
}));

vi.mock('#lib/server/db/schema.js', () => tables);

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		select: () => ({
			from: (table: { __table?: string }) => ({
				where: async () => {
					if (mocks.failQueries) {
						throw new Error('database is locked');
					}
					return table.__table === 'episodes' ? mocks.seasonEpisodes : mocks.queueRows;
				}
			})
		})
	}
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({ warn: mocks.warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() })
}));

vi.mock('#lib/utils/format.js', () => ({
	todayDateString: () => '2026-11-10'
}));

import { resolveEpisodePackScope } from './episode-pack-scope.js';

describe('resolveEpisodePackScope', () => {
	beforeEach(() => {
		mocks.seasonEpisodes = [];
		mocks.queueRows = [];
		mocks.failQueries = false;
		mocks.warn.mockReset();
	});

	it('returns the missing monitored episodes of the season, sorted', async () => {
		mocks.seasonEpisodes = [
			{ id: 'ep-3', episodeNumber: 3 },
			{ id: 'ep-1', episodeNumber: 1 },
			{ id: 'ep-2', episodeNumber: 2 }
		];

		const scope = await resolveEpisodePackScope({
			seriesId: 'series-1',
			seasonNumber: 1,
			targetEpisode: 3,
			targetEpisodeId: 'ep-3'
		});

		expect(scope).toEqual([
			{ episodeId: 'ep-1', episodeNumber: 1 },
			{ episodeId: 'ep-2', episodeNumber: 2 },
			{ episodeId: 'ep-3', episodeNumber: 3 }
		]);
	});

	it('drops episodes that an active queue row already covers', async () => {
		mocks.seasonEpisodes = [
			{ id: 'ep-1', episodeNumber: 1 },
			{ id: 'ep-2', episodeNumber: 2 },
			{ id: 'ep-3', episodeNumber: 3 }
		];
		mocks.queueRows = [{ episodeIds: ['ep-1', 'ep-2'] }, { episodeIds: null }];

		const scope = await resolveEpisodePackScope({
			seriesId: 'series-1',
			seasonNumber: 1,
			targetEpisode: 3,
			targetEpisodeId: 'ep-3'
		});

		expect(scope).toEqual([{ episodeId: 'ep-3', episodeNumber: 3 }]);
	});

	it('keeps the triggering episode when the library has no row for it', async () => {
		mocks.seasonEpisodes = [{ id: 'ep-1', episodeNumber: 1 }];

		const scope = await resolveEpisodePackScope({
			seriesId: 'series-1',
			seasonNumber: 1,
			targetEpisode: 7
		});

		expect(scope).toEqual([
			{ episodeId: 'ep-1', episodeNumber: 1 },
			{ episodeId: undefined, episodeNumber: 7 }
		]);
	});

	it('falls back to the pointer episode and logs when the scope query fails', async () => {
		mocks.failQueries = true;

		const scope = await resolveEpisodePackScope({
			seriesId: 'series-1',
			seasonNumber: 1,
			targetEpisode: 7,
			targetEpisodeId: 'ep-7'
		});

		expect(scope).toEqual([{ episodeId: 'ep-7', episodeNumber: 7 }]);
		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});

	it('does not duplicate the triggering episode when it is already in the scope', async () => {
		mocks.seasonEpisodes = [
			{ id: 'ep-7', episodeNumber: 7 },
			{ id: 'ep-8', episodeNumber: 8 }
		];

		const scope = await resolveEpisodePackScope({
			seriesId: 'series-1',
			seasonNumber: 1,
			targetEpisode: 7,
			targetEpisodeId: 'ep-7'
		});

		expect(scope).toEqual([
			{ episodeId: 'ep-7', episodeNumber: 7 },
			{ episodeId: 'ep-8', episodeNumber: 8 }
		]);
	});
});

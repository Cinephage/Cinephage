import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { series, episodes, monitoringHistory } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const testDb: TestDatabase = createTestDb();

const { searchMissingMovies, searchMissingEpisodes } = vi.hoisted(() => ({
	searchMissingMovies: vi.fn(),
	searchMissingEpisodes: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

vi.mock('../search/MonitoringSearchService.js', () => ({
	monitoringSearchService: {
		searchMissingMovies,
		searchMissingEpisodes
	}
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	})
}));

afterAll(() => destroyTestDb(testDb));

const SERIES_ID = 'missing-content-series';
const EPISODE_ID = 'missing-content-ep-1';

beforeEach(async () => {
	testDb.db.delete(monitoringHistory).run();
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();

	searchMissingMovies.mockReset();
	searchMissingEpisodes.mockReset();
	searchMissingMovies.mockResolvedValue({
		items: [],
		summary: { searched: 0, found: 0, grabbed: 0, skipped: 0, errors: 0 }
	});

	await testDb.db.insert(series).values({
		id: SERIES_ID,
		tmdbId: 9001,
		title: 'Avatar: Seven Havens',
		path: '/series/avatar-seven-havens'
	});
	await testDb.db.insert(episodes).values({
		id: EPISODE_ID,
		seriesId: SERIES_ID,
		seasonNumber: 1,
		episodeNumber: 1,
		monitored: true
	});
});

describe('executeMissingContentTask - season pack vs per-episode labeling', () => {
	it('does not stamp episodeId on a season-pack search attempt, so it is not mislabeled as that one episode', async () => {
		searchMissingEpisodes.mockResolvedValue({
			items: [
				{
					// Season-pack attempt: itemId is only a representative episode id,
					// not the actual search target - seasonNumber marks it as such.
					itemId: EPISODE_ID,
					itemType: 'episode',
					title: 'Avatar: Seven Havens Season 1',
					searched: true,
					releasesFound: 3,
					grabbed: false,
					seasonNumber: 1
				}
			],
			summary: { searched: 1, found: 1, grabbed: 0, skipped: 0, errors: 0 }
		});

		const { executeMissingContentTask } = await import('./MissingContentTask.js');
		await executeMissingContentTask(null);

		const rows = testDb.db.select().from(monitoringHistory).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].episodeId).toBeNull();
		expect(rows[0].seriesId).toBe(SERIES_ID);
		expect(rows[0].seasonNumber).toBe(1);
	});

	it('still stamps episodeId for a genuine per-episode search result (no seasonNumber)', async () => {
		searchMissingEpisodes.mockResolvedValue({
			items: [
				{
					itemId: EPISODE_ID,
					itemType: 'episode',
					title: 'Avatar: Seven Havens S01E01',
					searched: true,
					releasesFound: 2,
					grabbed: false
				}
			],
			summary: { searched: 1, found: 1, grabbed: 0, skipped: 0, errors: 0 }
		});

		const { executeMissingContentTask } = await import('./MissingContentTask.js');
		await executeMissingContentTask(null);

		const rows = testDb.db
			.select()
			.from(monitoringHistory)
			.where(eq(monitoringHistory.episodeId, EPISODE_ID))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0].episodeId).toBe(EPISODE_ID);
		expect(rows[0].seasonNumber).toBeNull();
	});
});

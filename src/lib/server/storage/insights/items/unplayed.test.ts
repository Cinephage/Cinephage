import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { storageItems, movies } from '#lib/server/db/schema.js';
import { createStorageItem, createMovie } from '../../../../../test/fixtures/index.js';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { unplayedResolver } from './unplayed.js';

describe('unplayedResolver', () => {
	afterAll(() => destroyTestDb(testDb));
	beforeEach(() => clearTestDb(testDb));

	it('returns items from itemIds with title enrichment', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'up-movie', tmdbId: 100, title: 'Unplayed Movie' }));
		await testDb.db
			.insert(storageItems)
			.values(
				createStorageItem({ id: 'si-1', tmdbId: 100, title: 'Unplayed Movie', itemType: 'movie' })
			);
		const result = await unplayedResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'unplayed',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Unplayed items',
				summary: '1 item unplayed',
				detailsJson: JSON.stringify({ itemIds: ['si-1'], thresholdDays: 30 }),
				reclaimableBytes: null,
				itemCount: 1,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0].title).toBe('Unplayed Movie');
		expect(result.total).toBe(1);
	});

	it('paginates correctly', async () => {
		for (let i = 0; i < 5; i++) {
			await testDb.db.insert(storageItems).values(
				createStorageItem({
					id: `si-${i}`,
					tmdbId: 100 + i,
					title: `Item ${i}`,
					itemType: 'movie'
				})
			);
		}
		const ids = Array.from({ length: 5 }, (_, i) => `si-${i}`);
		const result = await unplayedResolver({
			db: testDb.db as any,
			page: 2,
			limit: 2,
			insight: {
				id: 'test',
				insightType: 'unplayed',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Unplayed',
				summary: null,
				detailsJson: JSON.stringify({ itemIds: ids, thresholdDays: 30 }),
				reclaimableBytes: null,
				itemCount: 5,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(result.items).toHaveLength(2);
		expect(result.total).toBe(5);
	});

	it('groups multiple unplayed episodes of the same series into one row', async () => {
		// storage_items tracks TV content per-episode, so three unplayed
		// episodes of the same show must not render as three separate rows.
		await testDb.db.insert(storageItems).values([
			createStorageItem({
				id: 'ep-1',
				tmdbId: 200,
				itemType: 'episode',
				title: 'S01E01',
				seriesName: 'Grouped Show',
				seasonNumber: 1,
				episodeNumber: 1
			}),
			createStorageItem({
				id: 'ep-2',
				tmdbId: 200,
				itemType: 'episode',
				title: 'S01E02',
				seriesName: 'Grouped Show',
				seasonNumber: 1,
				episodeNumber: 2
			}),
			createStorageItem({
				id: 'ep-3',
				tmdbId: 200,
				itemType: 'episode',
				title: 'S01E03',
				seriesName: 'Grouped Show',
				seasonNumber: 1,
				episodeNumber: 3
			})
		]);

		const result = await unplayedResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'unplayed',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Unplayed',
				summary: null,
				detailsJson: JSON.stringify({ itemIds: ['ep-1', 'ep-2', 'ep-3'], thresholdDays: 30 }),
				reclaimableBytes: null,
				itemCount: 3,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});

		expect(result.total).toBe(1);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].title).toBe('Grouped Show');
		expect(result.items[0].kind).toBe('series');
		expect(result.items[0].badges?.[0].label).toBe('3 unplayed episodes');
	});

	it('returns empty when no itemIds', async () => {
		const result = await unplayedResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'unplayed',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Unplayed',
				summary: null,
				detailsJson: JSON.stringify({ itemIds: [], thresholdDays: 30 }),
				reclaimableBytes: null,
				itemCount: 0,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(result.items).toHaveLength(0);
	});

	it('handles missing detailsJson', async () => {
		const result = await unplayedResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'unplayed',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Unplayed',
				summary: null,
				detailsJson: null,
				reclaimableBytes: null,
				itemCount: 0,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(result.items).toHaveLength(0);
	});
});

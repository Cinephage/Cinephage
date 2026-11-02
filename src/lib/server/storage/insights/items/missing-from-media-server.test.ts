import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { storageItems } from '#lib/server/db/schema.js';
import { createStorageItem } from '../../../../../test/fixtures/index.js';

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

import { missingFromMediaServerResolver } from './missing-from-media-server.js';

describe('missingFromMediaServerResolver', () => {
	afterAll(() => destroyTestDb(testDb));
	beforeEach(() => clearTestDb(testDb));

	it('returns items with sourceSystem=local', async () => {
		for (let i = 0; i < 3; i++) {
			await testDb.db.insert(storageItems).values(
				createStorageItem({
					id: `local-${i}`,
					title: `Local Item ${i}`,
					sourceSystem: 'local',
					itemType: 'movie',
					tmdbId: 200 + i
				})
			);
		}
		await testDb.db.insert(storageItems).values(
			createStorageItem({
				id: 'server-item',
				title: 'Server Item',
				sourceSystem: 'server',
				tmdbId: 999
			})
		);
		const result = await missingFromMediaServerResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'missing-from-media-server',
				severity: 'info',
				scope: 'global',
				scopeId: null,
				title: 'Missing from server',
				summary: '3 items',
				detailsJson: null,
				reclaimableBytes: null,
				itemCount: 3,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(result.items).toHaveLength(3);
		expect(result.total).toBe(3);
	});

	it('groups multiple missing episodes of the same series into one row', async () => {
		await testDb.db.insert(storageItems).values([
			createStorageItem({
				id: 'ep-1',
				tmdbId: 300,
				itemType: 'episode',
				title: 'S01E01',
				seriesName: 'Grouped Show',
				sourceSystem: 'local',
				seasonNumber: 1,
				episodeNumber: 1
			}),
			createStorageItem({
				id: 'ep-2',
				tmdbId: 300,
				itemType: 'episode',
				title: 'S01E02',
				seriesName: 'Grouped Show',
				sourceSystem: 'local',
				seasonNumber: 1,
				episodeNumber: 2
			})
		]);

		const result = await missingFromMediaServerResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'missing-from-media-server',
				severity: 'info',
				scope: 'global',
				scopeId: null,
				title: 'Missing',
				summary: null,
				detailsJson: null,
				reclaimableBytes: null,
				itemCount: 2,
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
		expect(result.items[0].badges?.[0].label).toBe('2 episodes missing');
	});

	it('returns empty when none', async () => {
		const result = await missingFromMediaServerResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'missing-from-media-server',
				severity: 'info',
				scope: 'global',
				scopeId: null,
				title: 'Missing',
				summary: '0 items',
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
		expect(result.total).toBe(0);
	});
});

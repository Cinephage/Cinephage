import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { movies } from '#lib/server/db/schema.js';
import { createMovie } from '../../../../../test/fixtures/index.js';

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

import { duplicateItemsResolver } from './duplicate-items.js';

describe('duplicateItemsResolver', () => {
	afterAll(() => destroyTestDb(testDb));
	beforeEach(() => clearTestDb(testDb));

	it('returns items from detailsJson payload', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'dup-movie-a', tmdbId: 100, title: 'Movie A' }));
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'dup-movie-b', tmdbId: 200, title: 'Movie B' }));

		const result = await duplicateItemsResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test-insight',
				insightType: 'duplicate-items',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Duplicate items',
				summary: '2 movies have multiple files',
				detailsJson: JSON.stringify({
					items: [
						{ tmdbId: 100, title: 'Movie A', fileCount: 2 },
						{ tmdbId: 200, title: 'Movie B', fileCount: 3 }
					]
				}),
				reclaimableBytes: null,
				itemCount: 2,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});

		expect(result.items).toHaveLength(2);
		expect(result.total).toBe(2);
		expect(result.items[0].kind).toBe('movie');
		expect(result.items[0].title).toBe('Movie A');
		expect(result.items[0].href).toBe('/library/movie/dup-movie-a');
	});

	it('handles pagination slicing', async () => {
		const result = await duplicateItemsResolver({
			db: testDb.db as any,
			page: 2,
			limit: 1,
			insight: {
				id: 'test',
				insightType: 'duplicate-items',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Duplicate items',
				summary: '3 movies have multiple files',
				detailsJson: JSON.stringify({
					items: [
						{ tmdbId: 100, title: 'A', fileCount: 2 },
						{ tmdbId: 200, title: 'B', fileCount: 2 },
						{ tmdbId: 300, title: 'C', fileCount: 2 }
					]
				}),
				reclaimableBytes: null,
				itemCount: 3,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].title).toBe('B');
		expect(result.total).toBe(3);
	});

	it('returns empty for no items', async () => {
		const result = await duplicateItemsResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'duplicate-items',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Test',
				summary: null,
				detailsJson: JSON.stringify({ items: [] }),
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

	it('handles missing detailsJson gracefully', async () => {
		const result = await duplicateItemsResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'duplicate-items',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Test',
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
		expect(result.total).toBe(0);
	});
});

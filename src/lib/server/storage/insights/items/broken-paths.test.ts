import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { movies, series } from '#lib/server/db/schema.js';
import { createMovie, createSeries } from '../../../../../test/fixtures/index.js';

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

import { brokenPathsResolver } from './broken-paths.js';

describe('brokenPathsResolver', () => {
	afterAll(() => destroyTestDb(testDb));
	beforeEach(() => clearTestDb(testDb));

	it('returns items from detailsJson', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'bp-movie', tmdbId: 100, title: 'Broken Movie' }));
		const result = await brokenPathsResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'broken-paths',
				severity: 'critical',
				scope: 'global',
				scopeId: null,
				title: 'Broken file paths',
				summary: '1 item has broken path',
				detailsJson: JSON.stringify({
					items: [{ storageId: 's-1', title: 'Broken Movie', tmdbId: 100, itemType: 'movie' }]
				}),
				reclaimableBytes: null,
				itemCount: 1,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0].title).toBe('Broken Movie');
		expect(result.items[0].kind).toBe('movie');
		expect(result.items[0].href).toBe('/library/movie/bp-movie');
	});

	it('resolves the correct library page when a movie and a series share the same tmdbId (#601)', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'bp-movie-collision', tmdbId: 777, title: 'Shared Id' }));
		await testDb.db
			.insert(series)
			.values(createSeries({ id: 'bp-series-collision', tmdbId: 777, title: 'Shared Id Show' }));

		const result = await brokenPathsResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'broken-paths',
				severity: 'critical',
				scope: 'global',
				scopeId: null,
				title: 'Broken file paths',
				summary: null,
				detailsJson: JSON.stringify({
					items: [
						{ storageId: 'bp-movie-collision', title: 'Shared Id', tmdbId: 777, itemType: 'movie' },
						{
							storageId: 'bp-series-collision',
							title: 'Shared Id Show',
							tmdbId: 777,
							itemType: 'episode'
						}
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
		const movieItem = result.items.find((i) => i.title === 'Shared Id')!;
		const seriesItem = result.items.find((i) => i.title === 'Shared Id Show')!;
		expect(movieItem.kind).toBe('movie');
		expect(movieItem.href).toBe('/library/movie/bp-movie-collision');
		expect(seriesItem.kind).toBe('episode');
		expect(seriesItem.href).toBe('/library/tv/bp-series-collision');
	});

	it('handles pagination', async () => {
		const items = Array.from({ length: 4 }, (_, i) => ({
			storageId: `s-${i}`,
			title: `Item ${i}`,
			tmdbId: 100 + i,
			itemType: 'movie' as const
		}));
		const page1 = await brokenPathsResolver({
			db: testDb.db as any,
			page: 1,
			limit: 2,
			insight: {
				id: 'test',
				insightType: 'broken-paths',
				severity: 'critical',
				scope: 'global',
				scopeId: null,
				title: 'Test',
				summary: null,
				detailsJson: JSON.stringify({ items }),
				reclaimableBytes: null,
				itemCount: 4,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(page1.items).toHaveLength(2);
		expect(page1.total).toBe(4);
	});

	it('returns empty when no items', async () => {
		const result = await brokenPathsResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'broken-paths',
				severity: 'critical',
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
	});
});

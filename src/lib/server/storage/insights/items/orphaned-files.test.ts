import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { unmatchedFiles } from '#lib/server/db/schema.js';

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

import { orphanedFilesResolver } from './orphaned-files.js';

describe('orphanedFilesResolver', () => {
	afterAll(() => destroyTestDb(testDb));
	beforeEach(() => clearTestDb(testDb));

	it('returns paginated unmatched files', async () => {
		for (let i = 0; i < 5; i++) {
			await testDb.db.insert(unmatchedFiles).values({
				id: `of-${i}`,
				path: `/media/file${i}.mkv`,
				mediaType: 'movie',
				size: 1000000 * (i + 1),
				parsedTitle: `File ${i}`,
				parsedYear: 2024,
				reason: 'no_match',
				discoveredAt: new Date().toISOString()
			});
		}
		const result = await orphanedFilesResolver({
			db: testDb.db as any,
			page: 1,
			limit: 2,
			insight: {
				id: 'test',
				insightType: 'orphaned-files',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Unmatched files',
				summary: '5 files unmatched',
				detailsJson: JSON.stringify({ link: '/library/unmatched' }),
				reclaimableBytes: 5000000,
				itemCount: 5,
				firstDetectedAt: '',
				lastDetectedAt: '',
				dismissedAt: null,
				dismissedBy: null
			}
		});
		expect(result.items).toHaveLength(2);
		expect(result.total).toBe(5);
		expect(result.items[0].kind).toBe('file');
		expect(result.items[0].sizeBytes).toBe(1000000);
	});

	it('returns empty when no unmatched files', async () => {
		const result = await orphanedFilesResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'orphaned-files',
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

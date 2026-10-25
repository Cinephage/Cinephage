import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { rootFolders } from '#lib/server/db/schema.js';

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

import { healthIssuesResolver } from './health-issues.js';

async function insertFolder(id: string, name: string, path: string) {
	await testDb.db.insert(rootFolders).values({
		id,
		name,
		path,
		mediaType: 'movie',
		mediaSubType: 'standard',
		readOnly: false,
		isDefault: false,
		preserveSymlinks: false,
		defaultMonitored: true,
		createdAt: new Date().toISOString()
	});
}

describe('healthIssuesResolver', () => {
	afterAll(() => destroyTestDb(testDb));
	beforeEach(() => clearTestDb(testDb));

	it('returns folder items from detailsJson folderIds', async () => {
		await insertFolder('hi-f1', 'Movies', '/data/movies');
		await insertFolder('hi-f2', 'TV', '/data/tv');
		const result = await healthIssuesResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'health-issues',
				severity: 'critical',
				scope: 'global',
				scopeId: null,
				title: 'Inaccessible root folders',
				summary: '2 folders inaccessible',
				detailsJson: JSON.stringify({ folderIds: ['hi-f1', 'hi-f2'] }),
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
		expect(result.items[0].kind).toBe('folder');
		expect(result.items[0].href).toBe('/settings/monitoring/status/folders?folderId=hi-f1');
	});

	it('supports folderPaths', async () => {
		await insertFolder('hi-f1', 'Movies', '/data/movies');
		const result = await healthIssuesResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'health-issues',
				severity: 'critical',
				scope: 'global',
				scopeId: null,
				title: 'Inaccessible',
				summary: null,
				detailsJson: JSON.stringify({
					folderIds: ['hi-f1'],
					folderPaths: ['/data/movies']
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
	});

	it('returns empty when no folderIds', async () => {
		const result = await healthIssuesResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'health-issues',
				severity: 'warning',
				scope: 'global',
				scopeId: null,
				title: 'Test',
				summary: null,
				detailsJson: JSON.stringify({ folderIds: [] }),
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
		const result = await healthIssuesResolver({
			db: testDb.db as any,
			page: 1,
			limit: 50,
			insight: {
				id: 'test',
				insightType: 'health-issues',
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
	});
});

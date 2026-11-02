import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { libraries, libraryScanHistory, rootFolders } from '#lib/server/db/schema.js';

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

import { HealthIssuesRule } from './HealthIssuesRule.js';
import type { RuleContext } from '../types.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinephage-health-'));
	tmpDirs.push(dir);
	return dir;
}

describe('HealthIssuesRule', () => {
	const rule = new HealthIssuesRule();

	afterAll(() => {
		for (const dir of tmpDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
		destroyTestDb(testDb);
	});

	afterEach(async () => {
		// These tables are not in clearTestDb's list, so clear them explicitly.
		// Clear child/dependent tables first to respect FK ordering.
		testDb.db.delete(libraryScanHistory).run();
		testDb.db.delete(libraries).run();
		testDb.db.delete(rootFolders).run();
	});

	beforeEach(async () => {
		testDb.db.delete(libraryScanHistory).run();
		testDb.db.delete(libraries).run();
		testDb.db.delete(rootFolders).run();
		await clearTestDb(testDb);
	});

	it('has type "health-issues"', () => {
		expect(rule.type).toBe('health-issues');
	});

	it('flags inaccessible root folders as critical', async () => {
		await testDb.db.insert(rootFolders).values({
			id: 'rf-1',
			name: 'Missing Folder',
			path: '/nonexistent/cinephage-path',
			mediaType: 'movie'
		});
		// Add a completed scan so the needs-scan check does not also fire
		await testDb.db.insert(libraryScanHistory).values({
			id: 'scan-1',
			scanType: 'full',
			rootFolderId: 'rf-1',
			status: 'completed',
			startedAt: '2026-06-01T00:00:00.000Z'
		});

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('critical');
		expect(findings[0].itemCount).toBe(1);
	});

	it('flags read-only root folders as info', async () => {
		const dir = makeTmpDir();
		await testDb.db.insert(rootFolders).values({
			id: 'rf-2',
			name: 'Read Only Folder',
			path: dir,
			mediaType: 'movie',
			readOnly: true
		});
		await testDb.db.insert(libraryScanHistory).values({
			id: 'scan-2',
			scanType: 'full',
			rootFolderId: 'rf-2',
			status: 'completed',
			startedAt: '2026-06-01T00:00:00.000Z'
		});

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('info');
		expect(findings[0].itemCount).toBe(1);
	});

	it('flags root folders needing a scan as warning', async () => {
		const dir = makeTmpDir();
		await testDb.db.insert(rootFolders).values({
			id: 'rf-3',
			name: 'Never Scanned',
			path: dir,
			mediaType: 'movie'
		});
		// No scan history at all

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe('warning');
		expect(findings[0].itemCount).toBe(1);
	});

	it('flags libraries without a root folder as warning', async () => {
		await testDb.db.insert(libraries).values({
			id: 'lib-1',
			name: 'Rootless Library',
			slug: 'rootless',
			mediaType: 'movie'
		});

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		const noRootLib = findings.find((f) => f.title.includes('root folder'));
		expect(noRootLib).toBeDefined();
		expect(noRootLib?.severity).toBe('warning');
		expect(noRootLib?.itemCount).toBe(1);
	});

	it('returns zero findings when everything is healthy', async () => {
		const dir = makeTmpDir();
		await testDb.db.insert(rootFolders).values({
			id: 'rf-4',
			name: 'Healthy Folder',
			path: dir,
			mediaType: 'movie'
		});
		await testDb.db.insert(libraryScanHistory).values({
			id: 'scan-4',
			scanType: 'full',
			rootFolderId: 'rf-4',
			status: 'completed',
			startedAt: '2026-06-01T00:00:00.000Z'
		});
		await testDb.db.insert(libraries).values({
			id: 'lib-2',
			name: 'Healthy Library',
			slug: 'healthy',
			mediaType: 'movie',
			defaultRootFolderId: 'rf-4'
		});

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(0);
	});

	it('returns zero findings with empty database', async () => {
		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});
});

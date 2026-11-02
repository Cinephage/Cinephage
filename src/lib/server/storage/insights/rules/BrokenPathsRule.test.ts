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
import {
	episodeFiles,
	movies,
	movieFiles,
	rootFolders,
	series,
	storageItems
} from '#lib/server/db/schema.js';

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

import { BrokenPathsRule } from './BrokenPathsRule.js';
import type { RuleContext } from '../types.js';
import { createStorageItem } from '../../../../../test/fixtures/storage.js';
import {
	createMovie,
	createMovieFile,
	createSeries,
	createEpisodeFile
} from '../../../../../test/fixtures/index.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinephage-broken-'));
	tmpDirs.push(dir);
	return dir;
}

describe('BrokenPathsRule', () => {
	const rule = new BrokenPathsRule();

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

	afterEach(() => {
		// root_folders is not in clearTestDb's list; clear explicitly after the
		// referencing tables are wiped.
		testDb.db.delete(rootFolders).run();
	});

	beforeEach(async () => {
		testDb.db.delete(rootFolders).run();
		await clearTestDb(testDb);
	});

	it('has type "broken-paths"', () => {
		expect(rule.type).toBe('broken-paths');
	});

	it('flags items whose file path does not exist', async () => {
		const tmpDir = makeTmpDir();
		const tmpFile = path.join(tmpDir, 'movie.mkv');
		fs.writeFileSync(tmpFile, 'test');

		await testDb.db.insert(rootFolders).values({
			id: 'rf-1',
			name: 'Test Folder',
			path: tmpDir,
			mediaType: 'movie'
		});
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'm-1',
				tmdbId: 100,
				title: 'Existing File',
				rootFolderId: 'rf-1',
				path: ''
			})
		);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-1',
				movieId: 'm-1',
				relativePath: 'movie.mkv'
			}) as typeof movieFiles.$inferInsert
		);
		await testDb.db.insert(storageItems).values(
			createStorageItem({
				id: 'si-1',
				tmdbId: 100,
				title: 'Existing',
				movieFileId: 'mf-1',
				rootFolderId: 'rf-1'
			})
		);

		// And a broken one
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'm-2',
				tmdbId: 200,
				title: 'Missing File',
				rootFolderId: 'rf-1',
				path: ''
			})
		);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-2',
				movieId: 'm-2',
				relativePath: 'nonexistent.mkv'
			}) as typeof movieFiles.$inferInsert
		);
		await testDb.db.insert(storageItems).values(
			createStorageItem({
				id: 'si-2',
				tmdbId: 200,
				title: 'Missing',
				movieFileId: 'mf-2',
				rootFolderId: 'rf-1'
			})
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
		expect(findings[0].severity).toBe('critical');
		// itemType must travel with each broken item - movie and series tmdbIds
		// are independent namespaces, so the resolver needs this to pick the
		// right library page instead of guessing from tmdbId alone (#601).
		const detailItems = (findings[0].details as { items: Array<{ itemType: string }> }).items;
		expect(detailItems[0].itemType).toBe('movie');
	});

	it('returns zero findings when all movie paths exist', async () => {
		const tmpDir = makeTmpDir();
		const tmpFile = path.join(tmpDir, 'good.mkv');
		fs.writeFileSync(tmpFile, 'test');

		await testDb.db.insert(rootFolders).values({
			id: 'rf-2',
			name: 'Good Folder',
			path: tmpDir,
			mediaType: 'movie'
		});
		await testDb.db
			.insert(movies)
			.values(
				createMovie({ id: 'm-3', tmdbId: 300, title: 'Good', rootFolderId: 'rf-2', path: '' })
			);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-3',
				movieId: 'm-3',
				relativePath: 'good.mkv'
			}) as typeof movieFiles.$inferInsert
		);
		await testDb.db.insert(storageItems).values(
			createStorageItem({
				id: 'si-3',
				tmdbId: 300,
				title: 'Good',
				movieFileId: 'mf-3',
				rootFolderId: 'rf-2'
			})
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});

	it('flags episode-backed items with broken paths', async () => {
		const tmpDir = makeTmpDir();
		const tmpFile = path.join(tmpDir, 'ep.mkv');
		fs.writeFileSync(tmpFile, 'test');

		await testDb.db.insert(rootFolders).values({
			id: 'rf-3',
			name: 'TV Folder',
			path: tmpDir,
			mediaType: 'tv'
		});
		await testDb.db
			.insert(series)
			.values(
				createSeries({ id: 's-1', tmdbId: 500, title: 'Show', rootFolderId: 'rf-3', path: '' })
			);
		// Existing episode file
		await testDb.db.insert(episodeFiles).values(
			createEpisodeFile({
				id: 'ef-1',
				seriesId: 's-1',
				relativePath: 'ep.mkv'
			}) as typeof episodeFiles.$inferInsert
		);
		await testDb.db.insert(storageItems).values(
			createStorageItem({
				id: 'si-4',
				tmdbId: 500,
				title: 'Good Ep',
				episodeFileId: 'ef-1',
				rootFolderId: 'rf-3',
				itemType: 'episode',
				seasonNumber: 1,
				episodeNumber: 1
			})
		);
		// Broken episode file
		await testDb.db.insert(episodeFiles).values(
			createEpisodeFile({
				id: 'ef-2',
				seriesId: 's-1',
				relativePath: 'missing-ep.mkv'
			}) as typeof episodeFiles.$inferInsert
		);
		await testDb.db.insert(storageItems).values(
			createStorageItem({
				id: 'si-5',
				tmdbId: 500,
				title: 'Broken Ep',
				episodeFileId: 'ef-2',
				rootFolderId: 'rf-3',
				itemType: 'episode',
				seasonNumber: 1,
				episodeNumber: 2
			})
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
		expect(findings[0].severity).toBe('critical');
		const detailItems = (findings[0].details as { items: Array<{ itemType: string }> }).items;
		expect(detailItems[0].itemType).toBe('episode');
	});

	it('returns zero findings when no file-backed items exist', async () => {
		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});
});

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { movies, movieFiles } from '#lib/server/db/schema.js';

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

import { DuplicateItemsRule } from './DuplicateItemsRule.js';
import type { RuleContext } from '../types.js';
import { createMovie, createMovieFile } from '../../../../../test/fixtures/index.js';

describe('DuplicateItemsRule', () => {
	const rule = new DuplicateItemsRule();

	afterAll(() => destroyTestDb(testDb));
	beforeEach(async () => {
		await clearTestDb(testDb);
	});

	it('has type "duplicate-items"', () => {
		expect(rule.type).toBe('duplicate-items');
	});

	it('detects movies with multiple files for the same tmdbId', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-1', tmdbId: 100, title: 'Duplicate Movie' }));
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-1',
				movieId: 'm-1',
				relativePath: 'version-a.mkv',
				size: 1000
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-2',
				movieId: 'm-1',
				relativePath: 'version-b.mkv',
				size: 2000
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
		expect(findings[0].severity).toBe('warning');
		expect(findings[0].title).toContain('Duplicate');
	});

	it('does not flag a multi-quality movie with files at different resolutions', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-mq', tmdbId: 300, title: 'Multi-Quality Movie' }));
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-mq-1',
				movieId: 'm-mq',
				relativePath: 'multi-2160p.mkv',
				quality: { resolution: '2160p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-mq-2',
				movieId: 'm-mq',
				relativePath: 'multi-1080p.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(0);
	});

	it('flags a movie with two files at the same resolution', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-sr', tmdbId: 400, title: 'Same Resolution Movie' }));
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-sr-1',
				movieId: 'm-sr',
				relativePath: 'dup-a.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-sr-2',
				movieId: 'm-sr',
				relativePath: 'dup-b.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
	});

	it('reports the duplicate file count for a movie with a same-resolution pair among mixed resolutions', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-mix', tmdbId: 500, title: 'Mixed Resolutions Movie' }));
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-mix-1',
				movieId: 'm-mix',
				relativePath: 'mix-2160p.mkv',
				quality: { resolution: '2160p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-mix-2',
				movieId: 'm-mix',
				relativePath: 'mix-1080p-a.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-mix-3',
				movieId: 'm-mix',
				relativePath: 'mix-1080p-b.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		const items = (findings[0].details?.items as { fileCount: number }[]) ?? [];
		expect(items[0].fileCount).toBe(2);
	});

	it('does not flag a movie whose files differ only by unknown vs known resolution', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-unk', tmdbId: 600, title: 'Unknown Resolution Movie' }));
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-unk-1',
				movieId: 'm-unk',
				relativePath: 'known-2160p.mkv',
				quality: { resolution: '2160p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-unk-2',
				movieId: 'm-unk',
				relativePath: 'unknown-quality.mkv'
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(0);
	});

	it('returns zero findings when no duplicates exist', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-2', tmdbId: 200, title: 'Single File' }));
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-3',
				movieId: 'm-2',
				size: 1000
			}) as typeof movieFiles.$inferInsert
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});
});

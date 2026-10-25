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

import { RedundantQualityTiersRule } from './RedundantQualityTiersRule.js';
import type { RuleContext } from '../types.js';
import { createMovie, createMovieFile } from '../../../../../test/fixtures/index.js';

describe('RedundantQualityTiersRule', () => {
	const rule = new RedundantQualityTiersRule();

	afterAll(() => destroyTestDb(testDb));
	beforeEach(async () => {
		await clearTestDb(testDb);
	});

	it('has type "redundant-quality-tiers"', () => {
		expect(rule.type).toBe('redundant-quality-tiers');
	});

	it('flags a single-quality movie whose extra file is below the best', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-1', tmdbId: 100, title: 'Single Quality Extra' }));
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-1',
				movieId: 'm-1',
				relativePath: 'best-1080p.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-2',
				movieId: 'm-1',
				relativePath: 'extra-720p.mkv',
				quality: { resolution: '720p' }
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
		expect(findings[0].severity).toBe('info');
		expect(findings[0].type).toBe('redundant-quality-tiers');
		const items = (findings[0].details?.items as { redundantCount: number }[]) ?? [];
		expect(items[0].redundantCount).toBe(1);
	});

	it('flags a multi-quality movie with a file outside the desired tiers', async () => {
		await testDb.db.insert(movies).values({
			...createMovie({ id: 'm-mq', tmdbId: 200, title: 'Multi Quality Extra' }),
			desiredQualities: ['2160p', '1080p']
		});
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-mq-1',
				movieId: 'm-mq',
				relativePath: 'mq-2160p.mkv',
				quality: { resolution: '2160p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-mq-2',
				movieId: 'm-mq',
				relativePath: 'mq-1080p.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-mq-3',
				movieId: 'm-mq',
				relativePath: 'mq-720p.mkv',
				quality: { resolution: '720p' }
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		const items = (findings[0].details?.items as { redundantCount: number }[]) ?? [];
		expect(items[0].redundantCount).toBe(1);
	});

	it('does not flag a multi-quality movie when all files fit the desired tiers', async () => {
		await testDb.db.insert(movies).values({
			...createMovie({ id: 'm-fit', tmdbId: 300, title: 'Multi Quality Fit' }),
			desiredQualities: ['2160p', '1080p']
		});
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-fit-1',
				movieId: 'm-fit',
				relativePath: 'fit-2160p.mkv',
				quality: { resolution: '2160p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-fit-2',
				movieId: 'm-fit',
				relativePath: 'fit-1080p.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(0);
	});

	it('does not flag a single-file movie whose file fits', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-single', tmdbId: 400, title: 'Single File' }));
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-single',
				movieId: 'm-single',
				relativePath: 'only-1080p.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(0);
	});

	it('does not count unknown-resolution files as redundant', async () => {
		await testDb.db.insert(movies).values({
			...createMovie({ id: 'm-unk', tmdbId: 500, title: 'Unknown Tier' }),
			desiredQualities: ['2160p', '1080p']
		});
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-unk-1',
				movieId: 'm-unk',
				relativePath: 'unk-2160p.mkv',
				quality: { resolution: '2160p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-unk-2',
				movieId: 'm-unk',
				relativePath: 'unk-1080p.mkv',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-unk-3',
				movieId: 'm-unk',
				relativePath: 'unk-unknown.mkv'
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(0);
	});
});

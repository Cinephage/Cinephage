import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper.js';
import { movies, movieFiles, scoringProfiles } from '#lib/server/db/schema.js';

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

import { QualityBelowCutoffRule } from './QualityBelowCutoffRule.js';
import type { RuleContext } from '../types.js';
import { createMovie, createMovieFile } from '../../../../../test/fixtures/index.js';

describe('QualityBelowCutoffRule', () => {
	const rule = new QualityBelowCutoffRule();

	afterAll(() => destroyTestDb(testDb));
	beforeEach(async () => {
		await clearTestDb(testDb);
	});

	it('has type "quality-below-cutoff"', () => {
		expect(rule.type).toBe('quality-below-cutoff');
	});

	it('detects movies below the profile minResolution', async () => {
		await testDb.db.insert(scoringProfiles).values({
			id: 'profile-1',
			name: 'Test Profile',
			minResolution: '1080p'
		});
		await testDb.db
			.insert(movies)
			.values(
				createMovie({ id: 'm-1', tmdbId: 100, title: 'Low Quality', scoringProfileId: 'profile-1' })
			);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-1',
				movieId: 'm-1',
				quality: { resolution: '720p' }
			}) as typeof movieFiles.$inferInsert
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
		expect(findings[0].severity).toBe('info');
		// itemType must travel with each item - movie and series tmdbIds are
		// independent namespaces, so the resolver needs this to pick the right
		// library page instead of guessing from tmdbId alone (#601).
		const items = (findings[0].details as { items: Array<{ itemType: string }> }).items;
		expect(items[0].itemType).toBe('movie');
	});

	it('does not flag movies at or above cutoff', async () => {
		await testDb.db.insert(scoringProfiles).values({
			id: 'profile-2',
			name: 'Test Profile',
			minResolution: '1080p'
		});
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'm-2',
				tmdbId: 200,
				title: 'Good Quality',
				scoringProfileId: 'profile-2'
			})
		);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-2',
				movieId: 'm-2',
				quality: { resolution: '1080p' }
			}) as typeof movieFiles.$inferInsert
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});

	it('does not flag movies when profile has no minResolution', async () => {
		await testDb.db.insert(scoringProfiles).values({
			id: 'profile-3',
			name: 'No Cutoff',
			minResolution: null
		});
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'm-3',
				tmdbId: 300,
				title: 'Any Quality',
				scoringProfileId: 'profile-3'
			})
		);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-3',
				movieId: 'm-3',
				quality: { resolution: '480p' }
			}) as typeof movieFiles.$inferInsert
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});

	it('does not flag a multi-quality movie whose best file meets the cutoff', async () => {
		await testDb.db.insert(scoringProfiles).values({
			id: 'profile-mq',
			name: 'Test Profile',
			minResolution: '2160p'
		});
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'm-mq',
				tmdbId: 500,
				title: 'Multi-Quality',
				scoringProfileId: 'profile-mq'
			})
		);
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

	it('flags a multi-file movie once when its best file is still below cutoff', async () => {
		await testDb.db.insert(scoringProfiles).values({
			id: 'profile-inv',
			name: 'Test Profile',
			minResolution: '1080p'
		});
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'm-inv',
				tmdbId: 600,
				title: 'Multi-Quality Below Cutoff',
				scoringProfileId: 'profile-inv'
			})
		);
		await testDb.db.insert(movieFiles).values([
			createMovieFile({
				id: 'mf-inv-1',
				movieId: 'm-inv',
				relativePath: 'best-720p.mkv',
				quality: { resolution: '720p' }
			}) as typeof movieFiles.$inferInsert,
			createMovieFile({
				id: 'mf-inv-2',
				movieId: 'm-inv',
				relativePath: 'worse-480p.mkv',
				quality: { resolution: '480p' }
			}) as typeof movieFiles.$inferInsert
		]);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].itemCount).toBe(1);
		const items = (findings[0].details?.items as { currentResolution: string }[]) ?? [];
		expect(items[0].currentResolution).toBe('720p');
	});

	it('does not flag movies with no scoring profile', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'm-4', tmdbId: 400, title: 'No Profile', scoringProfileId: null }));
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-4',
				movieId: 'm-4',
				quality: { resolution: '480p' }
			}) as typeof movieFiles.$inferInsert
		);

		const findings = await rule.evaluate({
			db: testDb.db as RuleContext['db'],
			now: '2026-07-01T00:00:00.000Z'
		});
		expect(findings).toHaveLength(0);
	});
});

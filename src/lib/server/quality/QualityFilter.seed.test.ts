import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import { scoringProfiles } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { DEFAULT_PROFILES } from '#lib/server/scoring/index.js';
import { QualityFilter } from './QualityFilter.js';

const testDb: TestDatabase = createTestDb();

vi.mock('../db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

describe('QualityFilter.seedDefaultScoringProfiles indexer allowlist', () => {
	afterAll(() => destroyTestDb(testDb));

	beforeEach(() => clearTestDb(testDb));

	it('seeds built-in profiles with a null allowlist', async () => {
		const filter = new QualityFilter();
		await filter.seedDefaultScoringProfiles();

		const rows = await testDb.db.select().from(scoringProfiles);
		expect(rows).toHaveLength(DEFAULT_PROFILES.length);
		for (const row of rows) {
			expect(row.allowedIndexerIds).toBeNull();
		}
	});

	it('does not overwrite a user-set allowlist on a built-in profile', async () => {
		const filter = new QualityFilter();
		await filter.seedDefaultScoringProfiles();

		// Simulate an admin restricting the built-in Balanced profile.
		await testDb.db
			.update(scoringProfiles)
			.set({ allowedIndexerIds: ['indexer-a'] })
			.where(eq(scoringProfiles.id, 'balanced'));

		// Startup sync must leave user-owned settings alone.
		await filter.seedDefaultScoringProfiles();

		const balanced = await testDb.db
			.select()
			.from(scoringProfiles)
			.where(eq(scoringProfiles.id, 'balanced'))
			.get();

		expect(balanced?.allowedIndexerIds).toEqual(['indexer-a']);
	});
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import { scoringProfiles } from '#lib/server/db/schema.js';
import { COMPACT_PROFILE, BALANCED_PROFILE } from '../scoring';

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

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn()
	}),
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn()
	}
}));

const { QualityFilter } = await import('./QualityFilter');

describe('QualityFilter (database)', () => {
	let filter: InstanceType<typeof QualityFilter>;

	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
		filter = new QualityFilter();
	});

	describe('getDefaultScoringProfile', () => {
		it('should return size limits from scoringProfiles for a built-in default profile', async () => {
			testDb.db
				.insert(scoringProfiles)
				.values({
					id: 'compact',
					name: 'Compact',
					description: 'Compact profile',
					isDefault: true,
					isBuiltIn: true,
					formatScores: COMPACT_PROFILE.formatScores,
					resolutionOrder: COMPACT_PROFILE.resolutionOrder,
					upgradesAllowed: COMPACT_PROFILE.upgradesAllowed,
					minScore: COMPACT_PROFILE.minScore,
					upgradeUntilScore: COMPACT_PROFILE.upgradeUntilScore,
					minScoreIncrement: COMPACT_PROFILE.minScoreIncrement,
					movieMinSizeGb: 0.5,
					movieMaxSizeGb: 5.0,
					episodeMinSizeMb: 50,
					episodeMaxSizeMb: 450
				})
				.run();

			const profile = await filter.getDefaultScoringProfile();

			expect(profile.episodeMaxSizeMb).toBe(450);
			expect(profile.episodeMinSizeMb).toBe(50);
			expect(profile.movieMinSizeGb).toBe(0.5);
			expect(profile.movieMaxSizeGb).toBe(5.0);
			expect(profile.name).toBe('Compact');
		});

		it('should return null size limits when scoringProfiles has null values for a built-in default', async () => {
			testDb.db
				.insert(scoringProfiles)
				.values({
					id: 'compact',
					name: 'Compact',
					description: 'Compact profile',
					isDefault: true,
					isBuiltIn: true,
					formatScores: COMPACT_PROFILE.formatScores,
					resolutionOrder: COMPACT_PROFILE.resolutionOrder,
					upgradesAllowed: COMPACT_PROFILE.upgradesAllowed,
					minScore: COMPACT_PROFILE.minScore,
					upgradeUntilScore: COMPACT_PROFILE.upgradeUntilScore,
					minScoreIncrement: COMPACT_PROFILE.minScoreIncrement,
					movieMinSizeGb: null,
					movieMaxSizeGb: null,
					episodeMinSizeMb: null,
					episodeMaxSizeMb: null
				})
				.run();

			const profile = await filter.getDefaultScoringProfile();

			expect(profile.episodeMaxSizeMb).toBeNull();
			expect(profile.episodeMinSizeMb).toBeNull();
			expect(profile.movieMinSizeGb).toBeNull();
			expect(profile.movieMaxSizeGb).toBeNull();
		});

		it('should return size limits directly from scoringProfiles for custom default profiles', async () => {
			testDb.db
				.insert(scoringProfiles)
				.values({
					id: 'my-custom-profile',
					name: 'My Custom',
					description: 'Custom profile with size limits',
					isDefault: true,
					formatScores: BALANCED_PROFILE.formatScores,
					resolutionOrder: BALANCED_PROFILE.resolutionOrder,
					upgradesAllowed: true,
					minScore: 0,
					upgradeUntilScore: -1,
					minScoreIncrement: 0,
					movieMinSizeGb: 1.0,
					movieMaxSizeGb: 10.0,
					episodeMinSizeMb: 100,
					episodeMaxSizeMb: 800
				})
				.run();

			const profile = await filter.getDefaultScoringProfile();

			expect(profile.movieMinSizeGb).toBe(1.0);
			expect(profile.movieMaxSizeGb).toBe(10.0);
			expect(profile.episodeMinSizeMb).toBe(100);
			expect(profile.episodeMaxSizeMb).toBe(800);
			expect(profile.name).toBe('My Custom');
		});
	});

	describe('getProfile', () => {
		it('should return size limits from scoringProfiles for built-in profiles', async () => {
			testDb.db
				.insert(scoringProfiles)
				.values({
					id: 'compact',
					name: 'Compact',
					description: 'Compact profile',
					isDefault: false,
					isBuiltIn: true,
					formatScores: COMPACT_PROFILE.formatScores,
					resolutionOrder: COMPACT_PROFILE.resolutionOrder,
					upgradesAllowed: COMPACT_PROFILE.upgradesAllowed,
					minScore: COMPACT_PROFILE.minScore,
					upgradeUntilScore: COMPACT_PROFILE.upgradeUntilScore,
					minScoreIncrement: COMPACT_PROFILE.minScoreIncrement,
					movieMinSizeGb: 0.5,
					movieMaxSizeGb: 5.0,
					episodeMinSizeMb: 50,
					episodeMaxSizeMb: 450
				})
				.run();

			const profile = await filter.getProfile('compact');

			expect(profile).not.toBeNull();
			expect(profile!.episodeMaxSizeMb).toBe(450);
			expect(profile!.episodeMinSizeMb).toBe(50);
			expect(profile!.movieMinSizeGb).toBe(0.5);
			expect(profile!.movieMaxSizeGb).toBe(5.0);
		});
	});
});

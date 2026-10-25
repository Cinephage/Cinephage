import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper';
import {
	api,
	type ProfilesListResponse,
	type ProfileResponse,
	type ErrorResponse,
	type DeleteResponse
} from '../../../test/api-helper';
import { scoringProfiles } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { DEFAULT_PROFILES } from '#lib/server/scoring/index.js';

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

vi.mock('#lib/server/quality/index.js', () => ({
	qualityFilter: {
		clearProfileCache: vi.fn()
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

function seedBuiltInProfiles() {
	for (const profile of DEFAULT_PROFILES) {
		testDb.db
			.insert(scoringProfiles)
			.values({
				id: profile.id,
				name: profile.name,
				description: profile.description ?? null,
				formatScores: profile.formatScores,
				resolutionOrder: profile.resolutionOrder,
				upgradesAllowed: profile.upgradesAllowed,
				minScore: profile.minScore,
				upgradeUntilScore: profile.upgradeUntilScore,
				minScoreIncrement: profile.minScoreIncrement,
				isBuiltIn: true,
				isDefault: profile.id === 'balanced'
			})
			.run();
	}
}

const { GET, POST, PUT, DELETE } = await import('./+server');

describe('Scoring Profiles API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
		seedBuiltInProfiles();
	});

	describe('GET /api/scoring-profiles', () => {
		it('returns built-in profiles when database is empty', async () => {
			const { status, data } = await api.get<ProfilesListResponse>(GET);

			expect(status).toBe(200);
			expect(data.profiles.length).toBeGreaterThanOrEqual(4);
			expect(data.defaultProfileId).toBe('balanced');

			const profileIds = data.profiles.map((p) => p.id);
			expect(profileIds).toContain('quality');
			expect(profileIds).toContain('balanced');
			expect(profileIds).toContain('compact');
			expect(profileIds).toContain('streamer');

			const builtInProfiles = data.profiles.filter((p) => p.isBuiltIn);
			expect(builtInProfiles.length).toBeGreaterThanOrEqual(4);
		});

		it('returns balanced as default when no custom default is set', async () => {
			const { data } = await api.get<ProfilesListResponse>(GET);

			expect(data.defaultProfileId).toBe('balanced');

			const balanced = data.profiles.find((p) => p.id === 'balanced');
			expect(balanced?.isDefault).toBe(true);
		});

		it('returns custom profiles along with built-in profiles', async () => {
			await testDb.db.insert(scoringProfiles).values({
				id: 'my-custom',
				name: 'My Custom Profile',
				description: 'Test profile'
			});

			const { data } = await api.get<ProfilesListResponse>(GET);

			const customProfile = data.profiles.find((p) => p.id === 'my-custom');
			expect(customProfile).toBeDefined();
			expect(customProfile?.name).toBe('My Custom Profile');
			expect(customProfile?.isBuiltIn).toBe(false);
		});

		it('returns size limits on built-in profiles', async () => {
			await testDb.db
				.update(scoringProfiles)
				.set({
					movieMinSizeGb: 1.5,
					movieMaxSizeGb: 50,
					episodeMinSizeMb: 200,
					episodeMaxSizeMb: 5000
				})
				.where(eq(scoringProfiles.id, 'balanced'));

			const { data } = await api.get<ProfilesListResponse>(GET);

			const balanced = data.profiles.find((p) => p.id === 'balanced');
			expect(Number(balanced?.movieMinSizeGb)).toBe(1.5);
			expect(Number(balanced?.movieMaxSizeGb)).toBe(50);
			expect(Number(balanced?.episodeMinSizeMb)).toBe(200);
			expect(Number(balanced?.episodeMaxSizeMb)).toBe(5000);
		});

		it('returns custom profile as default when set', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'my-default',
				name: 'My Default',
				isDefault: true
			});

			const { data } = await api.get<ProfilesListResponse>(GET);

			expect(data.defaultProfileId).toBe('my-default');

			const myDefault = data.profiles.find((p) => p.id === 'my-default');
			expect(myDefault?.isDefault).toBe(true);

			const balanced = data.profiles.find((p) => p.id === 'balanced');
			expect(balanced?.isDefault).toBe(false);
		});
	});

	describe('POST /api/scoring-profiles', () => {
		it('creates profile with required fields only', async () => {
			const { status, data } = await api.post<ProfileResponse>(POST, {
				name: 'Test Profile'
			});

			expect(status).toBe(201);
			expect(data.name).toBe('Test Profile');
			expect(data.id).toBeDefined();
		});

		it('creates profile with custom ID', async () => {
			const { status, data } = await api.post<ProfileResponse>(POST, {
				id: 'custom-id',
				name: 'Custom ID Profile'
			});

			expect(status).toBe(201);
			expect(data.id).toBe('custom-id');
		});

		it('creates profile with all optional fields', async () => {
			const { status, data } = await api.post<ProfileResponse>(POST, {
				id: 'full-profile',
				name: 'Full Profile',
				description: 'A complete profile',
				upgradesAllowed: false,
				minScore: 100,
				upgradeUntilScore: 5000,
				minScoreIncrement: 50,
				formatScores: { 'format-1': 500, 'format-2': -200 },
				movieMinSizeGb: 2,
				movieMaxSizeGb: 100,
				episodeMinSizeMb: 300,
				episodeMaxSizeMb: 10000
			});

			expect(status).toBe(201);
			expect(data.upgradesAllowed).toBe(false);
			expect(data.minScore).toBe(100);
			expect(data.upgradeUntilScore).toBe(5000);
			expect(data.minScoreIncrement).toBe(50);
			expect(data.formatScores).toEqual({ 'format-1': 500, 'format-2': -200 });
			expect(Number(data.movieMinSizeGb)).toBe(2);
			expect(Number(data.movieMaxSizeGb)).toBe(100);
		});

		it('copies formatScores from built-in profile', async () => {
			const { status, data } = await api.post<ProfileResponse>(POST, {
				name: 'Copy of Quality',
				copyFromId: 'quality'
			});

			expect(status).toBe(201);
			expect(data.formatScores).toBeDefined();
			expect(Object.keys(data.formatScores!).length).toBeGreaterThan(0);
		});

		it('copies formatScores from custom profile', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'source-profile',
				name: 'Source',
				formatScores: { 'my-format': 1000 }
			});

			const { status, data } = await api.post<ProfileResponse>(POST, {
				name: 'Copy of Source',
				copyFromId: 'source-profile'
			});

			expect(status).toBe(201);
			expect(data.formatScores!['my-format']).toBe(1000);
		});

		it('merges explicit formatScores with copied scores', async () => {
			const { status, data } = await api.post<ProfileResponse>(POST, {
				name: 'Merged Profile',
				copyFromId: 'quality',
				formatScores: { 'custom-format': 999 }
			});

			expect(status).toBe(201);
			expect(data.formatScores!['custom-format']).toBe(999);
			expect(Object.keys(data.formatScores!).length).toBeGreaterThan(1);
		});

		it('rejects reserved profile IDs', async () => {
			const { status, data } = await api.post<ErrorResponse>(POST, {
				id: 'quality',
				name: 'Fake Quality'
			});

			expect(status).toBe(400);
			expect(data.error).toContain('reserved');
		});

		it('rejects duplicate profile IDs', async () => {
			await api.post<ProfileResponse>(POST, { id: 'duplicate-test', name: 'First' });

			const { status, data } = await api.post<ErrorResponse>(POST, {
				id: 'duplicate-test',
				name: 'Second'
			});

			expect(status).toBe(409);
			expect(data.error).toContain('already exists');
		});

		it('returns 404 for non-existent copyFromId', async () => {
			const { status, data } = await api.post<ErrorResponse>(POST, {
				name: 'Bad Copy',
				copyFromId: 'does-not-exist'
			});

			expect(status).toBe(404);
			expect(data.error).toContain('not found');
		});

		it('sets isDefault and clears other defaults', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'first-default',
				name: 'First Default',
				isDefault: true
			});

			const { data: second } = await api.post<ProfileResponse>(POST, {
				id: 'second-default',
				name: 'Second Default',
				isDefault: true
			});

			expect(second.isDefault).toBe(true);

			const first = await testDb.db
				.select()
				.from(scoringProfiles)
				.where(eq(scoringProfiles.id, 'first-default'));
			expect(first[0].isDefault).toBe(false);
		});

		it('validates required name field', async () => {
			const { status, data } = await api.post<ErrorResponse>(POST, {
				description: 'Missing name'
			});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});
	});

	describe('PUT /api/scoring-profiles', () => {
		it('updates custom profile fields', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'update-test',
				name: 'Original Name'
			});

			const { status, data } = await api.put<ProfileResponse>(PUT, {
				id: 'update-test',
				name: 'Updated Name',
				description: 'New description'
			});

			expect(status).toBe(200);
			expect(data.name).toBe('Updated Name');
			expect(data.description).toBe('New description');
		});

		it('partial update preserves existing fields', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'partial-test',
				name: 'Original',
				description: 'Original description',
				upgradesAllowed: false,
				minScore: 100
			});

			const { data } = await api.put<ProfileResponse>(PUT, {
				id: 'partial-test',
				name: 'Updated'
			});

			expect(data.name).toBe('Updated');
			expect(data.description).toBe('Original description');
			expect(data.upgradesAllowed).toBe(false);
			expect(data.minScore).toBe(100);
		});

		it('updates built-in profile size limits only', async () => {
			const { status, data } = await api.put<ProfileResponse>(PUT, {
				id: 'balanced',
				movieMinSizeGb: 2,
				movieMaxSizeGb: 80
			});

			expect(status).toBe(200);
			expect(Number(data.movieMinSizeGb)).toBe(2);
			expect(Number(data.movieMaxSizeGb)).toBe(80);
			expect(data.isBuiltIn).toBe(true);
		});

		it('sets isDefault on built-in profile', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'temp-default',
				name: 'Temp Default',
				isDefault: true
			});

			const { data } = await api.put<ProfileResponse>(PUT, {
				id: 'balanced',
				isDefault: true
			});

			expect(data.isDefault).toBe(true);

			const temp = await testDb.db
				.select()
				.from(scoringProfiles)
				.where(eq(scoringProfiles.id, 'temp-default'));
			expect(temp[0].isDefault).toBe(false);
		});

		it('returns 404 for non-existent custom profile', async () => {
			const { status, data } = await api.put<ErrorResponse>(PUT, {
				id: 'does-not-exist',
				name: 'New Name'
			});

			expect(status).toBe(404);
			expect(data.error).toContain('not found');
		});

		it('requires profile ID', async () => {
			const { status, data } = await api.put<ErrorResponse>(PUT, {
				name: 'No ID'
			});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});

		it('updates formatScores', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'format-test',
				name: 'Format Test',
				formatScores: { old: 100 }
			});

			const { data } = await api.put<ProfileResponse>(PUT, {
				id: 'format-test',
				formatScores: { new: 500 }
			});

			expect(data.formatScores).toEqual({ new: 500 });
		});
	});

	describe('DELETE /api/scoring-profiles', () => {
		it('deletes custom profile', async () => {
			await api.post<ProfileResponse>(POST, {
				id: 'delete-me',
				name: 'Delete Me'
			});

			const { status, data } = await api.delete<DeleteResponse>(DELETE, { id: 'delete-me' });

			expect(status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.deleted.id).toBe('delete-me');

			const remaining = await testDb.db
				.select()
				.from(scoringProfiles)
				.where(eq(scoringProfiles.id, 'delete-me'));
			expect(remaining.length).toBe(0);
		});

		it('rejects deletion of built-in profile', async () => {
			const { status, data } = await api.delete<ErrorResponse>(DELETE, { id: 'quality' });

			expect(status).toBe(400);
			expect(data.error).toContain('Cannot delete built-in');
		});

		it('returns 404 for non-existent profile', async () => {
			const { status, data } = await api.delete<ErrorResponse>(DELETE, { id: 'ghost' });

			expect(status).toBe(404);
			expect(data.error).toContain('not found');
		});

		it('requires profile ID', async () => {
			const { status, data } = await api.delete<ErrorResponse>(DELETE, {});

			expect(status).toBe(400);
			expect(data.error).toContain('Validation failed');
		});
	});
});

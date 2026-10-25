import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';

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

const { libraries, libraryRootFolders, rootFolders, scoringProfiles, languageProfiles } =
	await import('#lib/server/db/schema.js');
const { eq } = await import('drizzle-orm');
const { LibraryEntityService } = await import('./LibraryEntityService.js');

afterAll(() => {
	destroyTestDb(testDb);
});

async function seedLibraryWithDefaultRoot(
	librarySlug: string,
	rootPath: string,
	sortOrder: number
): Promise<{ libraryId: string; rootFolderId: string }> {
	const now = new Date().toISOString();

	const insertedRoot = await testDb.db
		.insert(rootFolders)
		.values({
			name: `Root ${librarySlug}`,
			path: rootPath,
			mediaType: 'movie',
			mediaSubType: 'standard'
		})
		.returning({ id: rootFolders.id })
		.all();
	const rootFolderId = insertedRoot[0]!.id;

	const insertedLibrary = await testDb.db
		.insert(libraries)
		.values({
			name: `Library ${librarySlug}`,
			slug: librarySlug,
			mediaType: 'movie',
			mediaSubType: 'standard',
			isSystem: false,
			systemKey: null,
			isDefault: false,
			defaultRootFolderId: rootFolderId,
			defaultSearchOnAdd: true,
			defaultWantsSubtitles: false,
			sortOrder,
			createdAt: now,
			updatedAt: now
		})
		.returning({ id: libraries.id })
		.all();
	const libraryId = insertedLibrary[0]!.id;

	return { libraryId, rootFolderId };
}

describe('LibraryEntityService.listLibraries (read-only regression)', () => {
	it('does not perform writes on the read path', async () => {
		// Seed a library with a defaultRootFolderId pointing at a root folder
		// that has no matching libraryRootFolders row. Before the fix, calling
		// listLibraries would trigger backfillLibraryRootFolders which inserts
		// a row. After the fix, no writes occur.
		const { libraryId, rootFolderId } = await seedLibraryWithDefaultRoot(
			'test-library-readonly',
			'/tmp/test-root-readonly',
			10
		);

		const assignmentsBefore = await testDb.db.select().from(libraryRootFolders).all();

		const service = new LibraryEntityService();
		const result = await service.listLibraries();

		expect(result.length).toBeGreaterThan(0);

		const assignmentsAfter = await testDb.db.select().from(libraryRootFolders).all();

		// No backfill insert should have occurred on the read path.
		expect(assignmentsAfter).toEqual(assignmentsBefore);

		// Cleanup.
		await testDb.db.delete(libraries).where(eq(libraries.id, libraryId));
		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});

	it('reconcileAll seeds missing assignments', async () => {
		// Confirms reconcileAll still performs the backfill that listLibraries no longer does.
		const { libraryId, rootFolderId } = await seedLibraryWithDefaultRoot(
			'test-library-reconcile',
			'/tmp/test-root-reconcile',
			20
		);

		const service = new LibraryEntityService();
		await service.reconcileAll();

		const assignments = await testDb.db
			.select()
			.from(libraryRootFolders)
			.where(eq(libraryRootFolders.libraryId, libraryId))
			.all();

		expect(assignments.length).toBeGreaterThan(0);

		// Cleanup.
		await testDb.db.delete(libraryRootFolders).where(eq(libraryRootFolders.libraryId, libraryId));
		await testDb.db.delete(libraries).where(eq(libraries.id, libraryId));
		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, rootFolderId));
	});
});

describe('LibraryEntityService quality profile per library', () => {
	async function seedScoringProfile(id: string): Promise<void> {
		await testDb.db
			.insert(scoringProfiles)
			.values({ id, name: `Profile ${id}` })
			.onConflictDoNothing()
			.run();
	}

	it('createLibrary persists the quality profile', async () => {
		await seedScoringProfile('test-profile-create');

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Profile Create Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			qualityProfileId: 'test-profile-create'
		});

		expect(created.qualityProfileId).toBe('test-profile-create');

		const row = await testDb.db
			.select({ qualityProfileId: libraries.qualityProfileId })
			.from(libraries)
			.where(eq(libraries.id, created.id))
			.get();
		expect(row?.qualityProfileId).toBe('test-profile-create');

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(scoringProfiles).where(eq(scoringProfiles.id, 'test-profile-create'));
	});

	it('updateLibrary sets the quality profile', async () => {
		await seedScoringProfile('test-profile-update');

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Profile Update Library',
			mediaType: 'movie',
			mediaSubType: 'standard'
		});

		const updated = await service.updateLibrary(created.id, {
			qualityProfileId: 'test-profile-update'
		});

		expect(updated.qualityProfileId).toBe('test-profile-update');

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(scoringProfiles).where(eq(scoringProfiles.id, 'test-profile-update'));
	});

	it('updateLibrary clears the quality profile when set to null', async () => {
		await seedScoringProfile('test-profile-clear');

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Profile Clear Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			qualityProfileId: 'test-profile-clear'
		});

		const updated = await service.updateLibrary(created.id, { qualityProfileId: null });

		expect(updated.qualityProfileId).toBeNull();

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(scoringProfiles).where(eq(scoringProfiles.id, 'test-profile-clear'));
	});

	it('createLibrary normalizes an empty string profile to null', async () => {
		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Profile Empty Create Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			qualityProfileId: ''
		});

		expect(created.qualityProfileId).toBeNull();

		const row = await testDb.db
			.select({ qualityProfileId: libraries.qualityProfileId })
			.from(libraries)
			.where(eq(libraries.id, created.id))
			.get();
		expect(row?.qualityProfileId).toBeNull();

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
	});

	it('updateLibrary normalizes an empty string profile to null', async () => {
		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Profile Empty Update Library',
			mediaType: 'movie',
			mediaSubType: 'standard'
		});

		const updated = await service.updateLibrary(created.id, { qualityProfileId: '' });

		expect(updated.qualityProfileId).toBeNull();

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
	});

	it('listLibraries returns the quality profile', async () => {
		await seedScoringProfile('test-profile-list');

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Profile List Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			qualityProfileId: 'test-profile-list'
		});

		const libraryEntities = await service.listLibraries();
		const found = libraryEntities.find((library) => library.id === created.id);
		expect(found?.qualityProfileId).toBe('test-profile-list');

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(scoringProfiles).where(eq(scoringProfiles.id, 'test-profile-list'));
	});
});

describe('LibraryEntityService language profile per library', () => {
	const LANGUAGE_PROFILE_ID = 'a0000000-0000-4000-8000-000000000001';

	async function seedLanguageProfile(): Promise<string> {
		await testDb.db
			.insert(languageProfiles)
			.values({
				id: LANGUAGE_PROFILE_ID,
				name: 'Lang Profile',
				audio: { preferOriginal: true, languages: [], mode: 'prefer' },
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
				cutoffRank: null,
				minimumScore: 70,
				upgradesAllowed: true
			})
			.onConflictDoNothing()
			.run();
		return LANGUAGE_PROFILE_ID;
	}

	it('createLibrary persists a validated language profile', async () => {
		const profileId = await seedLanguageProfile();

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Language Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			languageProfileId: profileId
		});

		expect(created.languageProfileId).toBe(profileId);

		const row = await testDb.db
			.select({ languageProfileId: libraries.languageProfileId })
			.from(libraries)
			.where(eq(libraries.id, created.id))
			.get();
		expect(row?.languageProfileId).toBe(profileId);

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(languageProfiles).where(eq(languageProfiles.id, profileId));
	});

	it('createLibrary rejects an unknown language profile', async () => {
		const service = new LibraryEntityService();

		await expect(
			service.createLibrary({
				name: 'Bad Language Library',
				mediaType: 'movie',
				mediaSubType: 'standard',
				languageProfileId: 'a0000000-0000-4000-8000-00000000dead'
			})
		).rejects.toThrow('Language profile not found');
	});

	it('updateLibrary sets the language profile', async () => {
		const profileId = await seedLanguageProfile();

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Language Update Library',
			mediaType: 'movie',
			mediaSubType: 'standard'
		});

		const updated = await service.updateLibrary(created.id, { languageProfileId: profileId });

		expect(updated.languageProfileId).toBe(profileId);

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(languageProfiles).where(eq(languageProfiles.id, profileId));
	});

	it('updateLibrary clears the language profile when set to null', async () => {
		const profileId = await seedLanguageProfile();

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Language Clear Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			languageProfileId: profileId
		});

		const updated = await service.updateLibrary(created.id, { languageProfileId: null });

		expect(updated.languageProfileId).toBeNull();

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(languageProfiles).where(eq(languageProfiles.id, profileId));
	});

	it('updateLibrary rejects an unknown language profile without changing the row', async () => {
		const profileId = await seedLanguageProfile();

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Language Invalid Update Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			languageProfileId: profileId
		});

		await expect(
			service.updateLibrary(created.id, {
				languageProfileId: 'a0000000-0000-4000-8000-00000000dead'
			})
		).rejects.toThrow('Language profile not found');

		const row = await testDb.db
			.select({ languageProfileId: libraries.languageProfileId })
			.from(libraries)
			.where(eq(libraries.id, created.id))
			.get();
		expect(row?.languageProfileId).toBe(profileId);

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(languageProfiles).where(eq(languageProfiles.id, profileId));
	});

	it('listLibraries returns the language profile', async () => {
		const profileId = await seedLanguageProfile();

		const service = new LibraryEntityService();
		const created = await service.createLibrary({
			name: 'Language List Library',
			mediaType: 'movie',
			mediaSubType: 'standard',
			languageProfileId: profileId
		});

		const libraryEntities = await service.listLibraries();
		const found = libraryEntities.find((library) => library.id === created.id);
		expect(found?.languageProfileId).toBe(profileId);

		await testDb.db.delete(libraries).where(eq(libraries.id, created.id));
		await testDb.db.delete(languageProfiles).where(eq(languageProfiles.id, profileId));
	});
});

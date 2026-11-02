import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import {
	movies,
	libraries,
	rootFolders,
	libraryRootFolders,
	languageProfiles
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

vi.mock('#lib/logging/index.js', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() },
	createChildLogger: vi.fn(() => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn()
	}))
}));

vi.mock('#lib/server/subtitles/services/SubtitleImportService.js', () => ({
	searchSubtitlesForMediaBatch: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/monitoring/MonitoringScheduler.js', () => ({
	monitoringScheduler: {
		getSettings: vi.fn().mockResolvedValue({ subtitleSearchOnImportEnabled: false })
	}
}));

const { POST } = await import('./+server');

const LIB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_LIB_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const MOVIE_A = '44444444-4444-4444-8444-444444444441';
const MOVIE_B = '44444444-4444-4444-8444-444444444442';

async function seedLibraryWithMovies(): Promise<void> {
	await testDb.db.insert(libraries).values([
		{
			id: LIB_ID,
			name: 'Movies',
			slug: 'movies-e2e',
			mediaType: 'movie'
		},
		{
			id: OTHER_LIB_ID,
			name: 'Other',
			slug: 'other-e2e',
			mediaType: 'movie'
		}
	]);
	await testDb.db.insert(rootFolders).values({
		id: 'rf-lib-e2e',
		name: 'Root',
		path: '/tmp/lib-e2e',
		mediaType: 'movie',
		readOnly: false
	});
	await testDb.db.insert(languageProfiles).values({
		id: PROFILE_ID,
		name: 'E2E',
		audio: { preferOriginal: true, languages: [], mode: 'prefer' },
		subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
		cutoffRank: null,
		minimumScore: 70,
		upgradesAllowed: true
	});
	await testDb.db
		.insert(libraryRootFolders)
		.values({ libraryId: LIB_ID, rootFolderId: 'rf-lib-e2e' });
	await testDb.db.insert(movies).values([
		{
			id: MOVIE_A,
			tmdbId: 101,
			title: 'A',
			path: 'a',
			libraryId: LIB_ID,
			subtitleRequirementsOverride: [{ tag: 'de', variant: 'regular', accessibility: 'any' }]
		},
		{
			id: MOVIE_B,
			tmdbId: 102,
			title: 'B',
			path: 'b',
			libraryId: LIB_ID
		},
		{
			id: '44444444-4444-4444-8444-444444444443',
			tmdbId: 103,
			title: 'Other-lib',
			path: 'c',
			libraryId: OTHER_LIB_ID
		}
	]);
}

describe('bulk-assign library-wide mode', () => {
	beforeEach(() => {
		clearTestDb(testDb);
		// clearTestDb's table list does not include these — clear explicitly
		// so the fixed fixture ids can be reused across tests.
		testDb.sqlite.prepare('DELETE FROM movies').run();
		testDb.sqlite.prepare('DELETE FROM series').run();
		testDb.sqlite.prepare('DELETE FROM library_root_folders').run();
		testDb.sqlite.prepare('DELETE FROM root_folders').run();
		testDb.sqlite.prepare('DELETE FROM libraries').run();
	});
	afterAll(() => destroyTestDb(testDb));

	it('assigns the profile to every library item and clears overrides', async () => {
		await seedLibraryWithMovies();

		const { status, data } = await api.post(POST, {
			mediaType: 'movie',
			libraryId: LIB_ID,
			languageProfileId: PROFILE_ID,
			clearOverrides: true
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true, updated: 2 }));

		const rows = testDb.db.select().from(movies).all();
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get(MOVIE_A)?.languageProfileId).toBe(PROFILE_ID);
		expect(byId.get(MOVIE_A)?.subtitleRequirementsOverride).toBeNull();
		expect(byId.get(MOVIE_B)?.languageProfileId).toBe(PROFILE_ID);
		// The other library's item is untouched.
		expect(byId.get('44444444-4444-4444-8444-444444444443')?.languageProfileId).toBeNull();
	});

	it('rejects a library of the wrong media type', async () => {
		await testDb.db.insert(libraries).values({
			id: LIB_ID,
			name: 'Shows',
			slug: 'shows-e2e',
			mediaType: 'tv'
		});

		const { status } = await api.post(POST, {
			mediaType: 'movie',
			libraryId: LIB_ID,
			languageProfileId: null
		});

		expect(status).toBe(400);
	});

	it('rejects libraryId together with explicit mediaIds', async () => {
		const { status } = await api.post(POST, {
			mediaType: 'movie',
			libraryId: LIB_ID,
			mediaIds: [MOVIE_A],
			languageProfileId: null
		});

		expect(status).toBe(400);
	});

	it('returns updated 0 for an empty library', async () => {
		await testDb.db.insert(libraries).values({
			id: LIB_ID,
			name: 'Empty',
			slug: 'empty-e2e',
			mediaType: 'movie'
		});

		const { status, data } = await api.post(POST, {
			mediaType: 'movie',
			libraryId: LIB_ID,
			languageProfileId: null
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true, updated: 0 }));
	});
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	languageProfiles,
	libraries,
	movies,
	rootFolders,
	subtitles
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

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieReleaseInfo: vi.fn().mockResolvedValue(null),
		getMovie: vi.fn().mockResolvedValue(null)
	}
}));

const { load } = await import('./+page.server');
type LoadEvent = { params: { id: string } };
type MovieLoadFn = (event: LoadEvent) => Promise<import('./+page.server').LibraryMoviePageData>;
// The exported load has SvelteKit's PageServerLoad signature; tests call it
// with a minimal event stub.
const loadFn = load as unknown as MovieLoadFn;
const { LanguageSettingsService } =
	await import('#lib/server/subtitles/services/LanguageSettingsService.js');

const LANGUAGE_PROFILE_ID = 'c0000000-0000-4000-8000-000000000001';
const MOVIE_ID = 'movie-loader-1';

async function seedMovie(options: { languageProfileId?: string | null } = {}): Promise<void> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-loader', name: 'Movies', path: '/media/movies', mediaType: 'movie' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({ id: 'lib-loader', name: 'Movies', slug: 'movies-loader', mediaType: 'movie' })
		.run();
	await testDb.db
		.insert(movies)
		.values({
			id: MOVIE_ID,
			tmdbId: 9201,
			title: 'Loader Movie',
			originalTitle: 'Loader Original',
			path: 'Loader Movie (2020)',
			rootFolderId: 'rf-loader',
			libraryId: 'lib-loader',
			hasFile: true,
			wantsSubtitles: true,
			preferOriginalTitle: null,
			languageProfileId: options.languageProfileId ?? null
		})
		.run();
}

async function seedLanguageProfile(): Promise<void> {
	await testDb.db
		.insert(languageProfiles)
		.values({
			id: LANGUAGE_PROFILE_ID,
			name: 'Loader Profile',
			audio: { preferOriginal: true, languages: [], mode: 'prefer' },
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			cutoffRank: null,
			minimumScore: 70,
			upgradesAllowed: true
		})
		.onConflictDoNothing()
		.run();
}

async function resetTables(): Promise<void> {
	for (const table of [
		'subtitles',
		'movie_files',
		'movies',
		'libraries',
		'root_folders',
		'language_profiles',
		'language_settings',
		'delay_profiles',
		'scoring_profiles',
		'download_queue'
	]) {
		testDb.sqlite.prepare(`DELETE FROM ${table}`).run();
	}
}

beforeEach(resetTables);

afterAll(() => destroyTestDb(testDb));

describe('library/movie/[id] page loader', () => {
	it('exposes the effective language profile with source and subtitleStatus', async () => {
		await seedLanguageProfile();
		await seedMovie({ languageProfileId: LANGUAGE_PROFILE_ID });
		await testDb.db.insert(subtitles).values({
			id: 'sub-loader-es',
			movieId: MOVIE_ID,
			language: 'es',
			relativePath: 'Loader.Movie.es.srt',
			format: 'srt'
		});

		const result = await loadFn({ params: { id: MOVIE_ID } });

		// Profile resolution mirrors GET /api/library/movies/[id].
		expect(result.effectiveLanguageProfile).toEqual({
			source: 'movie',
			profile: expect.objectContaining({ id: LANGUAGE_PROFILE_ID, name: 'Loader Profile' })
		});

		// Requirement-aware status computed with the same service as the API:
		// the es row does not satisfy the en requirement and its file is absent.
		expect(result.subtitleStatus.satisfied).toBe(false);
		expect(result.subtitleStatus.missing.map((m) => m.tag)).toEqual(['en']);
	});

	it('reports the default-source profile and falls back when nothing is configured', async () => {
		await seedMovie();

		const none = await loadFn({ params: { id: MOVIE_ID } });
		expect(none.effectiveLanguageProfile).toBeNull();
		// No profile -> everything satisfied (same semantics as the API).
		expect(none.subtitleStatus.satisfied).toBe(true);

		await seedLanguageProfile();
		await LanguageSettingsService.getInstance().update({ defaultProfileId: LANGUAGE_PROFILE_ID });

		const fallback = await loadFn({ params: { id: MOVIE_ID } });
		expect(fallback.effectiveLanguageProfile).toEqual({
			source: 'default',
			profile: expect.objectContaining({ id: LANGUAGE_PROFILE_ID })
		});
	});

	it('exposes the instance prefer-original-title default without touching per-item values', async () => {
		await seedMovie();
		const settingsService = LanguageSettingsService.getInstance();

		expect((await loadFn({ params: { id: MOVIE_ID } })).preferOriginalTitleDefault).toBe(false);

		await settingsService.update({ preferOriginalTitle: true });
		const result = await loadFn({ params: { id: MOVIE_ID } });
		expect(result.preferOriginalTitleDefault).toBe(true);
		// The per-item flag is passed through untouched for the edit modal.
		expect(result.movie.preferOriginalTitle).toBeNull();
	});
});

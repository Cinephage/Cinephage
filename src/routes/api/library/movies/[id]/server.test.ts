import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import { languageProfiles, libraries, movies, rootFolders } from '#lib/server/db/schema.js';
import { downloadQueue, downloadClients } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

const clientMocks = vi.hoisted(() => ({
	removeDownload: vi.fn().mockResolvedValue(undefined),
	getClientInstance: vi.fn()
}));
clientMocks.getClientInstance.mockResolvedValue({ removeDownload: clientMocks.removeDownload });

vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({
		getClientInstance: clientMocks.getClientInstance
	})
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

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieReleaseInfo: vi.fn().mockResolvedValue(null),
		getMovie: vi.fn().mockResolvedValue({ id: 1, title: 'TMDB Movie' }),
		getCollection: vi.fn().mockResolvedValue(null)
	}
}));

vi.mock('#lib/server/subtitles/services/SubtitleImportService.js', () => ({
	searchSubtitlesForNewMedia: vi.fn().mockResolvedValue(undefined),
	searchSubtitlesForMediaBatch: vi.fn().mockResolvedValue(undefined)
}));

const { GET, PATCH, DELETE } = await import('./+server');
const { eq } = await import('drizzle-orm');
const { LanguageSettingsService } =
	await import('#lib/server/subtitles/services/LanguageSettingsService.js');

const LANGUAGE_PROFILE_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PROFILE_ID = 'a0000000-0000-4000-8000-000000000002';

/**
 * Seed a language profile row directly (fixed id, valid v2 shape).
 */
async function seedLanguageProfile(id: string, name: string): Promise<void> {
	await testDb.db
		.insert(languageProfiles)
		.values({
			id,
			name,
			audio: { preferOriginal: true, languages: [], mode: 'prefer' },
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			cutoffRank: null,
			minimumScore: 70,
			upgradesAllowed: true
		})
		.onConflictDoNothing()
		.run();
}

/**
 * Seed a library + root folder + movie. Returns the movie id.
 */
async function seedMovie(options: { languageProfileId?: string | null } = {}): Promise<string> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-api-movie', name: 'Movies', path: '/media/movies', mediaType: 'movie' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({
			id: 'lib-api-movie',
			name: 'Movies Library',
			slug: 'movies-library-api',
			mediaType: 'movie'
		})
		.run();
	await testDb.db
		.insert(movies)
		.values({
			id: 'movie-api-1',
			tmdbId: 9001,
			title: 'Api Movie',
			path: 'Api Movie (2020)',
			rootFolderId: 'rf-api-movie',
			libraryId: 'lib-api-movie',
			languageProfileId: options.languageProfileId ?? null
		})
		.run();
	return 'movie-api-1';
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
		'download_queue',
		'download_clients'
	]) {
		testDb.sqlite.prepare(`DELETE FROM ${table}`).run();
	}
	clientMocks.removeDownload.mockClear();
	clientMocks.getClientInstance.mockClear();
	clientMocks.getClientInstance.mockResolvedValue({ removeDownload: clientMocks.removeDownload });
}

beforeEach(resetTables);

afterAll(() => destroyTestDb(testDb));

describe('GET /api/library/movies/[id] — effectiveLanguageProfile', () => {
	it('returns the effective profile with its source (override > library > default)', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Override');
		await seedLanguageProfile(OTHER_PROFILE_ID, 'Library');
		await testDb.db
			.update(libraries)
			.set({ languageProfileId: OTHER_PROFILE_ID })
			.where(eq(libraries.id, 'lib-api-movie'))
			.run();
		const movieId = await seedMovie({ languageProfileId: LANGUAGE_PROFILE_ID });
		const settingsService = LanguageSettingsService.getInstance();
		await settingsService.update({ defaultProfileId: OTHER_PROFILE_ID });

		const { status, data } = await api.get(GET, { params: { id: movieId } });
		const payload = data as { movie: { effectiveLanguageProfile: Record<string, unknown> | null } };

		expect(status).toBe(200);
		expect(payload.movie.effectiveLanguageProfile).toEqual({
			source: 'movie',
			profile: expect.objectContaining({ id: LANGUAGE_PROFILE_ID, name: 'Override' })
		});
	});

	it('reports the library source when the movie has no override', async () => {
		await seedLanguageProfile(OTHER_PROFILE_ID, 'Library');
		const movieId = await seedMovie();
		await testDb.db
			.update(libraries)
			.set({ languageProfileId: OTHER_PROFILE_ID })
			.where(eq(libraries.id, 'lib-api-movie'))
			.run();

		const { status, data } = await api.get(GET, { params: { id: movieId } });
		const payload = data as { movie: { effectiveLanguageProfile: Record<string, unknown> | null } };

		expect(status).toBe(200);
		expect(payload.movie.effectiveLanguageProfile).toEqual({
			source: 'library',
			profile: expect.objectContaining({ id: OTHER_PROFILE_ID })
		});
	});

	it('reports the default source when nothing else is configured, and null when none', async () => {
		const movieId = await seedMovie();

		const none = await api.get(GET, { params: { id: movieId } });
		expect(
			(none.data as { movie: { effectiveLanguageProfile: unknown } }).movie.effectiveLanguageProfile
		).toBeNull();

		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Default');
		await LanguageSettingsService.getInstance().update({ defaultProfileId: LANGUAGE_PROFILE_ID });

		const fallback = await api.get(GET, { params: { id: movieId } });
		expect(
			(fallback.data as { movie: { effectiveLanguageProfile: Record<string, unknown> } }).movie
				.effectiveLanguageProfile
		).toEqual({
			source: 'default',
			profile: expect.objectContaining({ id: LANGUAGE_PROFILE_ID })
		});
	});
});

describe('PATCH /api/library/movies/[id] — languageProfileId', () => {
	it('assigns an existing profile via the override column', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Assign Me');
		const movieId = await seedMovie();

		const { status } = await api.put(
			PATCH,
			{ languageProfileId: LANGUAGE_PROFILE_ID },
			{ params: { id: movieId } }
		);

		expect(status).toBe(200);
		const row = await testDb.db
			.select({ languageProfileId: movies.languageProfileId })
			.from(movies)
			.where(eq(movies.id, movieId))
			.get();
		expect(row?.languageProfileId).toBe(LANGUAGE_PROFILE_ID);
	});

	it('clears the override with null so the item inherits again', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Clear Me');
		const movieId = await seedMovie({ languageProfileId: LANGUAGE_PROFILE_ID });

		const { status } = await api.put(
			PATCH,
			{ languageProfileId: null },
			{ params: { id: movieId } }
		);

		expect(status).toBe(200);
		const row = await testDb.db
			.select({ languageProfileId: movies.languageProfileId })
			.from(movies)
			.where(eq(movies.id, movieId))
			.get();
		expect(row?.languageProfileId).toBeNull();
	});

	it('rejects an unknown profile id with 400 and leaves the column untouched', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Keep Me');
		const movieId = await seedMovie({ languageProfileId: LANGUAGE_PROFILE_ID });

		const { status, data } = await api.put(
			PATCH,
			{ languageProfileId: 'a0000000-0000-4000-8000-00000000dead' },
			{ params: { id: movieId } }
		);

		expect(status).toBe(400);
		expect(data).toEqual(
			expect.objectContaining({ success: false, error: expect.stringContaining('not found') })
		);
		const row = await testDb.db
			.select({ languageProfileId: movies.languageProfileId })
			.from(movies)
			.where(eq(movies.id, movieId))
			.get();
		expect(row?.languageProfileId).toBe(LANGUAGE_PROFILE_ID);
	});
});

/**
 * Seed a downloading movie: no imported files, one active queue item.
 * Returns { movieId, queueId }.
 */
async function seedDownloadingMovie(): Promise<{ movieId: string; queueId: string }> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-del-movie', name: 'Movies', path: '/media/movies', mediaType: 'movie' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({
			id: 'lib-del-movie',
			name: 'Movies Library',
			slug: 'movies-library-del',
			mediaType: 'movie'
		})
		.run();
	await testDb.db
		.insert(movies)
		.values({
			id: 'movie-del-1',
			tmdbId: 9002,
			title: 'Downloading Movie',
			path: '',
			rootFolderId: 'rf-del-movie',
			libraryId: 'lib-del-movie'
		})
		.run();
	await testDb.db
		.insert(downloadClients)
		.values({
			id: 'dc-del-1',
			name: 'Test Client',
			implementation: 'qbittorrent',
			host: 'localhost',
			port: 8080
		})
		.run();
	await testDb.db
		.insert(downloadQueue)
		.values({
			id: 'queue-del-1',
			downloadClientId: 'dc-del-1',
			downloadId: 'client-download-1',
			title: 'Downloading.Movie.2024.1080p',
			protocol: 'torrent',
			movieId: 'movie-del-1',
			status: 'downloading'
		})
		.run();
	return { movieId: 'movie-del-1', queueId: 'queue-del-1' };
}

async function movieRow(id: string) {
	return testDb.db.select().from(movies).where(eq(movies.id, id)).get();
}

async function queueRow(id: string) {
	return testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get();
}

describe('DELETE /api/library/movies/[id] — active downloads', () => {
	it('deletes files of a downloading movie without requiring library removal', async () => {
		const { movieId } = await seedDownloadingMovie();

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: movieId },
			url: `http://localhost/api/library/movies/${movieId}?deleteFiles=true`
		});

		expect(status).toBe(200);
		expect(clientMocks.removeDownload).toHaveBeenCalledWith('client-download-1', true);
		// Movie row stays, but the queue row whose client entry was removed
		// is dropped with it (tombstoned) instead of churning in recovery.
		expect(await movieRow(movieId)).toBeTruthy();
		expect(await queueRow('queue-del-1')).toBeFalsy();
	});

	it('keeps seeding when only removing from the library', async () => {
		const { movieId } = await seedDownloadingMovie();

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: movieId },
			url: `http://localhost/api/library/movies/${movieId}?removeFromLibrary=true`
		});

		expect(status).toBe(200);
		expect(clientMocks.removeDownload).not.toHaveBeenCalled();
		expect(await movieRow(movieId)).toBeFalsy();
		expect(await queueRow('queue-del-1')).toBeFalsy();
	});

	it('drops everything when deleting files and library together', async () => {
		const { movieId } = await seedDownloadingMovie();

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: movieId },
			url: `http://localhost/api/library/movies/${movieId}?deleteFiles=true&removeFromLibrary=true`
		});

		expect(status).toBe(200);
		expect(clientMocks.removeDownload).toHaveBeenCalledWith('client-download-1', true);
		expect(await movieRow(movieId)).toBeFalsy();
		expect(await queueRow('queue-del-1')).toBeFalsy();
	});
});

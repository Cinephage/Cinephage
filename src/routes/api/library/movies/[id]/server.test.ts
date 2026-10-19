import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import {
	downloadClients,
	downloadQueue,
	languageProfiles,
	libraries,
	movieFiles,
	movies,
	rootFolders
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
}

async function seedClient(): Promise<string> {
	await testDb.db
		.insert(downloadClients)
		.values({
			id: 'client-api-1',
			name: 'qbit',
			implementation: 'qbittorrent',
			enabled: true,
			host: 'localhost',
			port: 8080,
			useSsl: false,
			movieCategory: 'movies',
			tvCategory: 'tv'
		})
		.run();
	return 'client-api-1';
}

async function seedQueueRow(
	movieId: string,
	overrides: {
		indexerId?: string | null;
		protocol?: string;
		origin?: string | null;
		status?: string;
	} = {}
): Promise<string> {
	const id = `queue-${Math.random().toString(36).slice(2)}`;
	await testDb.db
		.insert(downloadQueue)
		.values({
			id,
			downloadClientId: 'client-api-1',
			downloadId: `hash-${id}`,
			title: 'Some.Release.2020.1080p.WEB-DL',
			movieId,
			indexerId: overrides.indexerId ?? null,
			protocol: overrides.protocol ?? 'torrent',
			// Default to a real Unmatched-tab row - only rows stamped with
			// `origin` are releasable on unmatch (see issue: indexerId being
			// null is NOT unique to this flow, arr_push grabs leave it null
			// too - tests that want to assert a *non*-releasable row must
			// pass `origin: null` explicitly).
			origin: overrides.origin === undefined ? 'unmatched_track' : overrides.origin,
			status: overrides.status ?? 'seeding'
		})
		.run();
	return id;
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

describe('DELETE /api/library/movies/[id] — unmatch releases client tracking', () => {
	it('file-less unmatch releases indexer-less rows back to Unmatched', async () => {
		const movieId = await seedMovie();
		await seedClient();
		const queueId = await seedQueueRow(movieId);

		const { status, data } = await api.delete(DELETE, undefined, {
			params: { id: movieId }
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true }));
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId))
		).toHaveLength(0);
		// Movie metadata is kept.
		expect(await testDb.db.select().from(movies).where(eq(movies.id, movieId))).toHaveLength(1);
	});

	it('still 400s when there is nothing to unmatch or release', async () => {
		const movieId = await seedMovie();

		const { status, data } = await api.delete(DELETE, undefined, {
			params: { id: movieId }
		});

		expect(status).toBe(400);
		expect(data).toEqual(expect.objectContaining({ success: false }));
	});

	it('preserves real grabs and debrid rows', async () => {
		const movieId = await seedMovie();
		await seedClient();
		const grabId = await seedQueueRow(movieId, { indexerId: 'indexer-1', origin: null });
		const debridId = await seedQueueRow(movieId, { protocol: 'debrid', origin: null });

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: movieId }
		});

		expect(status).toBe(400);
		for (const id of [grabId, debridId]) {
			expect(
				await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id))
			).toHaveLength(1);
		}
	});

	// GitHub issue: unmatch used to infer "came from the Unmatched tab" from
	// indexerId being null, which also matches a legitimate arr_push-pushed
	// grab (releasePush.ts never sets indexerId either) - a row with no
	// `origin` stamp must never be released, even with indexerId null.
	it('preserves a legitimate arr_push-shaped row (indexerId null, no origin)', async () => {
		const movieId = await seedMovie();
		await seedClient();
		const pushedId = await seedQueueRow(movieId, { indexerId: null, origin: null });

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: movieId }
		});

		expect(status).toBe(400);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, pushedId))
		).toHaveLength(1);
	});

	// Deleting a row that's actively importing out from under ImportService
	// (which holds an in-memory snapshot and never re-queries it) let the
	// import complete anyway and silently resurrect hasFile on a movie the
	// user just unmatched - importing/postprocessing rows must be left
	// alone instead of cancelled+deleted.
	it('leaves an actively-importing unmatched-flow row alone', async () => {
		const movieId = await seedMovie();
		await seedClient();
		const importingId = await seedQueueRow(movieId, { status: 'importing' });

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: movieId }
		});

		// Nothing else to release/delete and files.length === 0, but the
		// held-back row still counts as "something to release" for the guard.
		expect(status).toBe(200);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, importingId))
		).toHaveLength(1);
	});

	it('unmatch with files dissociates them and releases tracking', async () => {
		const movieId = await seedMovie();
		await seedClient();
		await testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-api-1',
				movieId,
				relativePath: 'Api Movie (2020).mkv',
				size: 1000
			})
			.run();
		const queueId = await seedQueueRow(movieId);

		const { status, data } = await api.delete(DELETE, undefined, {
			params: { id: movieId }
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true }));
		expect(await testDb.db.select().from(movieFiles)).toHaveLength(0);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId))
		).toHaveLength(0);
	});
});

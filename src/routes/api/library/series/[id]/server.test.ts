import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import {
	downloadClients,
	downloadQueue,
	episodeFiles,
	languageProfiles,
	libraries,
	rootFolders,
	series
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
		getTVShow: vi.fn().mockResolvedValue({ id: 1, name: 'TMDB Show', seasons: [] }),
		getSeason: vi.fn().mockResolvedValue({ episodes: [] })
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

const LANGUAGE_PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const OTHER_PROFILE_ID = 'b0000000-0000-4000-8000-000000000002';

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

async function seedSeries(options: { languageProfileId?: string | null } = {}): Promise<string> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-api-series', name: 'TV', path: '/media/tv', mediaType: 'tv' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({
			id: 'lib-api-series',
			name: 'TV Library',
			slug: 'tv-library-api',
			mediaType: 'tv'
		})
		.run();
	await testDb.db
		.insert(series)
		.values({
			id: 'series-api-1',
			tmdbId: 9101,
			title: 'Api Series',
			path: 'Api Series',
			rootFolderId: 'rf-api-series',
			libraryId: 'lib-api-series',
			languageProfileId: options.languageProfileId ?? null
		})
		.run();
	return 'series-api-1';
}

async function resetTables(): Promise<void> {
	for (const table of [
		'subtitles',
		'episode_files',
		'episodes',
		'seasons',
		'series',
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
	seriesId: string,
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
			title: 'Some.Show.S01E01.1080p.WEB-DL',
			seriesId,
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

describe('GET /api/library/series/[id] — effectiveLanguageProfile', () => {
	it('returns the effective profile with its source (override)', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'SeriesOverride');
		const seriesId = await seedSeries({ languageProfileId: LANGUAGE_PROFILE_ID });
		await seedLanguageProfile(OTHER_PROFILE_ID, 'Default');
		await LanguageSettingsService.getInstance().update({ defaultProfileId: OTHER_PROFILE_ID });

		const { status, data } = await api.get(GET, { params: { id: seriesId } });
		const payload = data as {
			series: { effectiveLanguageProfile: Record<string, unknown> | null };
		};

		expect(status).toBe(200);
		expect(payload.series.effectiveLanguageProfile).toEqual({
			source: 'series',
			profile: expect.objectContaining({ id: LANGUAGE_PROFILE_ID, name: 'SeriesOverride' })
		});
	});

	it('reports the library source when there is no override, and null when nothing resolves', async () => {
		const seriesId = await seedSeries();

		const none = await api.get(GET, { params: { id: seriesId } });
		expect(
			(none.data as { series: { effectiveLanguageProfile: unknown } }).series
				.effectiveLanguageProfile
		).toBeNull();

		await seedLanguageProfile(OTHER_PROFILE_ID, 'Library');
		await testDb.db
			.update(libraries)
			.set({ languageProfileId: OTHER_PROFILE_ID })
			.where(eq(libraries.id, 'lib-api-series'))
			.run();

		const fallback = await api.get(GET, { params: { id: seriesId } });
		expect(
			(fallback.data as { series: { effectiveLanguageProfile: Record<string, unknown> } }).series
				.effectiveLanguageProfile
		).toEqual({
			source: 'library',
			profile: expect.objectContaining({ id: OTHER_PROFILE_ID })
		});
	});
});

describe('PATCH /api/library/series/[id] — languageProfileId', () => {
	it('assigns an existing profile via the override column', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Assign Series');
		const seriesId = await seedSeries();

		const { status } = await api.put(
			PATCH,
			{ languageProfileId: LANGUAGE_PROFILE_ID },
			{ params: { id: seriesId } }
		);

		expect(status).toBe(200);
		const row = await testDb.db
			.select({ languageProfileId: series.languageProfileId })
			.from(series)
			.where(eq(series.id, seriesId))
			.get();
		expect(row?.languageProfileId).toBe(LANGUAGE_PROFILE_ID);
	});

	it('clears the override with null so the series inherits again', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Clear Series');
		const seriesId = await seedSeries({ languageProfileId: LANGUAGE_PROFILE_ID });

		const { status } = await api.put(
			PATCH,
			{ languageProfileId: null },
			{ params: { id: seriesId } }
		);

		expect(status).toBe(200);
		const row = await testDb.db
			.select({ languageProfileId: series.languageProfileId })
			.from(series)
			.where(eq(series.id, seriesId))
			.get();
		expect(row?.languageProfileId).toBeNull();
	});

	it('rejects an unknown profile id with 400 and leaves the column untouched', async () => {
		await seedLanguageProfile(LANGUAGE_PROFILE_ID, 'Keep Series');
		const seriesId = await seedSeries({ languageProfileId: LANGUAGE_PROFILE_ID });

		const { status, data } = await api.put(
			PATCH,
			{ languageProfileId: 'b0000000-0000-4000-8000-00000000dead' },
			{ params: { id: seriesId } }
		);

		expect(status).toBe(400);
		expect(data).toEqual(
			expect.objectContaining({ success: false, error: expect.stringContaining('not found') })
		);
		const row = await testDb.db
			.select({ languageProfileId: series.languageProfileId })
			.from(series)
			.where(eq(series.id, seriesId))
			.get();
		expect(row?.languageProfileId).toBe(LANGUAGE_PROFILE_ID);
	});
});

describe('DELETE /api/library/series/[id] — unmatch releases client tracking', () => {
	it('file-less unmatch releases indexer-less rows back to Unmatched', async () => {
		const seriesId = await seedSeries();
		await seedClient();
		const queueId = await seedQueueRow(seriesId);

		const { status, data } = await api.delete(DELETE, undefined, {
			params: { id: seriesId }
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true }));
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId))
		).toHaveLength(0);
		expect(await testDb.db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(1);
	});

	it('still 400s when there is nothing to unmatch or release', async () => {
		const seriesId = await seedSeries();

		const { status, data } = await api.delete(DELETE, undefined, {
			params: { id: seriesId }
		});

		expect(status).toBe(400);
		expect(data).toEqual(expect.objectContaining({ success: false }));
	});

	it('preserves real grabs and debrid rows', async () => {
		const seriesId = await seedSeries();
		await seedClient();
		const grabId = await seedQueueRow(seriesId, { indexerId: 'indexer-1', origin: null });
		const debridId = await seedQueueRow(seriesId, { protocol: 'debrid', origin: null });

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: seriesId }
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
		const seriesId = await seedSeries();
		await seedClient();
		const pushedId = await seedQueueRow(seriesId, { indexerId: null, origin: null });

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: seriesId }
		});

		expect(status).toBe(400);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, pushedId))
		).toHaveLength(1);
	});

	// Deleting a row that's actively importing out from under ImportService
	// (which holds an in-memory snapshot and never re-queries it) let the
	// import complete anyway and silently resurrect state on a series the
	// user just unmatched - importing/postprocessing rows must be left
	// alone instead of cancelled+deleted.
	it('leaves an actively-importing unmatched-flow row alone', async () => {
		const seriesId = await seedSeries();
		await seedClient();
		const importingId = await seedQueueRow(seriesId, { status: 'importing' });

		const { status } = await api.delete(DELETE, undefined, {
			params: { id: seriesId }
		});

		expect(status).toBe(200);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, importingId))
		).toHaveLength(1);
	});

	it('unmatch with files dissociates them and releases tracking', async () => {
		const seriesId = await seedSeries();
		await seedClient();
		await testDb.db
			.insert(episodeFiles)
			.values({
				id: 'efile-api-1',
				seriesId,
				seasonNumber: 1,
				relativePath: 'Season 01/Api Series S01E01.mkv',
				size: 1000
			})
			.run();
		const queueId = await seedQueueRow(seriesId);

		const { status, data } = await api.delete(DELETE, undefined, {
			params: { id: seriesId }
		});

		expect(status).toBe(200);
		expect(data).toEqual(expect.objectContaining({ success: true }));
		expect(await testDb.db.select().from(episodeFiles)).toHaveLength(0);
		expect(
			await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId))
		).toHaveLength(0);
	});
});

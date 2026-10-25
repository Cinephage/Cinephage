/**
 * PATCH /api/library/episodes/[id] — validation tests.
 *
 * The route must validate `subtitleRequirementsOverride` /
 * `wantsSubtitlesOverride` with the shared schema: an unvalidated override
 * (string, duplicate tuples, unknown tags) would be persisted and later crash
 * status computation.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';
import { episodes, libraries, rootFolders, series } from '#lib/server/db/schema.js';

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

vi.mock('#lib/server/library/searchOnAdd.js', () => ({
	searchOnAdd: {
		searchForEpisode: vi.fn().mockResolvedValue(undefined)
	}
}));

vi.mock('#lib/server/monitoring/MonitoringScheduler.js', () => ({
	monitoringScheduler: {
		getSettings: vi.fn().mockResolvedValue({ searchOnMonitorEnabled: false })
	}
}));

vi.mock('#lib/server/library/LibraryMediaEvents.js', () => ({
	libraryMediaEvents: {
		emitSeriesUpdated: vi.fn()
	}
}));

const { PATCH } = await import('./+server');
const { eq } = await import('drizzle-orm');

const EPISODE_ID = 'ep-api-1';
const SERIES_ID = 'series-api-1';

async function seedEpisode(): Promise<void> {
	await testDb.db
		.insert(rootFolders)
		.values({ id: 'rf-api-tv', name: 'TV', path: '/media/tv', mediaType: 'tv' })
		.run();
	await testDb.db
		.insert(libraries)
		.values({ id: 'lib-api-tv', name: 'TV Library', slug: 'tv-library-api', mediaType: 'tv' })
		.run();
	await testDb.db
		.insert(series)
		.values({
			id: SERIES_ID,
			tmdbId: 7777,
			title: 'Api Series',
			path: 'Api Series',
			rootFolderId: 'rf-api-tv',
			libraryId: 'lib-api-tv'
		})
		.run();
	await testDb.db
		.insert(episodes)
		.values({
			id: EPISODE_ID,
			seriesId: SERIES_ID,
			seasonNumber: 1,
			episodeNumber: 1,
			title: 'Pilot'
		})
		.run();
}

async function readEpisodeRow() {
	return testDb.db.select().from(episodes).where(eq(episodes.id, EPISODE_ID)).get();
}

beforeEach(async () => {
	testDb.sqlite.prepare('DELETE FROM episodes').run();
	testDb.sqlite.prepare('DELETE FROM series').run();
	testDb.sqlite.prepare('DELETE FROM root_folders').run();
	testDb.sqlite.prepare('DELETE FROM libraries').run();
	await seedEpisode();
});

afterAll(() => destroyTestDb(testDb));

describe('PATCH /api/library/episodes/[id]', () => {
	it('returns 404 for an unknown episode', async () => {
		const { status } = await api.put(
			PATCH,
			{ monitored: true },
			{ params: { id: 'missing-episode' } }
		);
		expect(status).toBe(404);
	});

	it('rejects an empty update with 400', async () => {
		const { status } = await api.put(PATCH, {}, { params: { id: EPISODE_ID } });
		expect(status).toBe(400);
	});

	it('rejects a non-array subtitle requirements override and leaves the row untouched', async () => {
		const { status } = await api.put(
			PATCH,
			{ subtitleRequirementsOverride: 'not-an-array' },
			{ params: { id: EPISODE_ID } }
		);

		expect(status).toBe(400);
		const row = await readEpisodeRow();
		expect(row?.subtitleRequirementsOverride).toBeNull();
	});

	it('rejects duplicate requirement tuples', async () => {
		const { status } = await api.put(
			PATCH,
			{
				subtitleRequirementsOverride: [{ tag: 'en' }, { tag: 'eng' }]
			},
			{ params: { id: EPISODE_ID } }
		);

		expect(status).toBe(400);
		expect((await readEpisodeRow())?.subtitleRequirementsOverride).toBeNull();
	});

	it('rejects unknown language tags', async () => {
		const { status } = await api.put(
			PATCH,
			{ subtitleRequirementsOverride: [{ tag: 'xx' }] },
			{ params: { id: EPISODE_ID } }
		);

		expect(status).toBe(400);
	});

	it('persists a canonicalized override and the tri-state gate', async () => {
		const { status } = await api.put(
			PATCH,
			{
				wantsSubtitlesOverride: true,
				subtitleRequirementsOverride: [{ tag: 'FRE', variant: 'forced' }]
			},
			{ params: { id: EPISODE_ID } }
		);

		expect(status).toBe(200);
		const row = await readEpisodeRow();
		expect(row?.wantsSubtitlesOverride).toBe(true);
		expect(row?.subtitleRequirementsOverride).toEqual([
			{ tag: 'fr', variant: 'forced', accessibility: 'any' }
		]);
	});

	it('clears the override with null (inherit via series)', async () => {
		await testDb.db
			.update(episodes)
			.set({
				subtitleRequirementsOverride: [{ tag: 'en', variant: 'regular', accessibility: 'any' }]
			})
			.where(eq(episodes.id, EPISODE_ID))
			.run();

		const { status } = await api.put(
			PATCH,
			{ subtitleRequirementsOverride: null },
			{ params: { id: EPISODE_ID } }
		);

		expect(status).toBe(200);
		expect((await readEpisodeRow())?.subtitleRequirementsOverride).toBeNull();
	});
});

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper.js';
import {
	storageItems,
	storageItemServerLinks,
	movieFiles,
	episodeFiles,
	movies,
	series,
	episodes,
	mediaServerSyncedItems,
	mediaBrowserServers
} from '#lib/server/db/schema.js';

// Mock the db module to return the test db through a getter so all consumers
// (including those imported transitively) hit the in-memory instance.
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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

// Suppress event subscriptions during tests - we call reconcile() directly.
vi.mock('#lib/server/library/library-scheduler.js', () => ({
	getLibraryScheduler: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() })
}));
vi.mock('#lib/server/mediaServerStats/MediaServerStatsSyncService.js', () => ({
	getMediaServerStatsSyncService: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() })
}));

import {
	getReconciliationService,
	__resetReconciliationServiceForTests
} from './ReconciliationService.js';
import {
	createMovie,
	createMovieFile,
	createSeries,
	createEpisode,
	createEpisodeFile
} from '../../../../test/fixtures/index.js';
import { createMediaServerItem } from '../../../../test/fixtures/storage.js';

describe('ReconciliationService', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(async () => {
		__resetReconciliationServiceForTests();
		await clearTestDb(testDb);
		// Seed a media browser server row so FK constraints on server_links are satisfied
		await testDb.db.insert(mediaBrowserServers).values({
			id: 'srv-1',
			name: 'Test Jellyfin',
			serverType: 'jellyfin',
			host: 'http://test',
			apiKey: 'key',
			enabled: true
		});
	});

	it('has correct BackgroundService metadata', () => {
		const service = getReconciliationService();
		expect(service.name).toBe('ReconciliationService');
		expect(typeof service.start).toBe('function');
		expect(typeof service.stop).toBe('function');
		expect(['pending', 'starting', 'ready', 'error']).toContain(service.status);
	});

	it('populates storage_items from local movie_files', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-1', tmdbId: 100, title: 'Inception' }));
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-1',
				movieId: 'movie-1',
				size: 5000000000
			}) as typeof movieFiles.$inferInsert
		);

		const service = getReconciliationService();
		const result = await service.reconcile();

		expect(result.skipped).toBe(false);
		expect(result.itemsInserted).toBeGreaterThanOrEqual(1);

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(1);
		expect(items[0].itemType).toBe('movie');
		expect(items[0].tmdbId).toBe(100);
		expect(items[0].title).toBe('Inception');
		expect(items[0].movieFileId).toBe('mf-1');
		expect(items[0].sourceSystem).toBe('local');
		expect(items[0].matchConfidence).toBe('exact');
	});

	it('populates storage_items from local episode_files', async () => {
		await testDb.db
			.insert(series)
			.values(createSeries({ id: 'series-1', tmdbId: 200, title: 'Breaking Bad' }));
		await testDb.db.insert(episodeFiles).values(
			createEpisodeFile({
				id: 'ef-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				episodeIds: ['ep-1']
			}) as typeof episodeFiles.$inferInsert
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(1);
		expect(items[0].itemType).toBe('episode');
		expect(items[0].tmdbId).toBe(200);
		expect(items[0].episodeFileId).toBe('ef-1');
		expect(items[0].seasonNumber).toBe(1);
	});

	it('creates server-only items when media_server_synced_items has no local match', async () => {
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-1',
				serverId: 'srv-1',
				serverItemId: 'jf-1',
				tmdbId: 300,
				title: 'Server-Only Movie',
				itemType: 'movie',
				fileSize: 1000000000
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(1);
		expect(items[0].sourceSystem).toBe('server');
		expect(items[0].matchConfidence).toBe('id');
		expect(items[0].movieFileId).toBeNull();

		const links = await testDb.db.select().from(storageItemServerLinks);
		expect(links).toHaveLength(1);
		expect(links[0].syncedItemId).toBe('msi-1');
		expect(links[0].serverId).toBe('srv-1');
	});

	it('links local and server entries to the same storage_items row (sourceSystem=both)', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-2', tmdbId: 400, title: 'Interstellar' }));
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-2',
				movieId: 'movie-2',
				size: 8000000000
			}) as typeof movieFiles.$inferInsert
		);
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-2',
				serverId: 'srv-1',
				serverItemId: 'jf-2',
				tmdbId: 400,
				title: 'Interstellar',
				itemType: 'movie'
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(1);
		expect(items[0].sourceSystem).toBe('both');
		expect(items[0].movieFileId).toBe('mf-2');

		const links = await testDb.db.select().from(storageItemServerLinks);
		expect(links).toHaveLength(1);
		expect(links[0].storageItemId).toBe(items[0].id);
	});

	it('matches a local movie to a server item with no tmdbId via imdbId fallback (#601)', async () => {
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'movie-imdb',
				tmdbId: 600,
				imdbId: 'tt1234567',
				title: 'Unresolved On Server'
			})
		);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-imdb',
				movieId: 'movie-imdb'
			}) as typeof movieFiles.$inferInsert
		);
		// Server synced the file but its metadata agent couldn't resolve TMDB;
		// it still carries the same IMDB id as the local movie.
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-imdb',
				serverId: 'srv-1',
				serverItemId: 'jf-imdb',
				tmdbId: null,
				imdbId: 'tt1234567',
				title: 'Unresolved On Server',
				itemType: 'movie'
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(1);
		expect(items[0].sourceSystem).toBe('both');
		expect(items[0].tmdbId).toBe(600);

		const links = await testDb.db.select().from(storageItemServerLinks);
		expect(links).toHaveLength(1);
		expect(links[0].storageItemId).toBe(items[0].id);
		expect(links[0].syncedItemId).toBe('msi-imdb');
	});

	it('does not match via imdbId fallback when the local movie has no imdbId', async () => {
		await testDb.db.insert(movies).values(
			createMovie({
				id: 'movie-no-imdb',
				tmdbId: 601,
				imdbId: null,
				title: 'No Imdb Local'
			})
		);
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-no-imdb',
				movieId: 'movie-no-imdb'
			}) as typeof movieFiles.$inferInsert
		);
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-no-imdb',
				serverId: 'srv-1',
				serverItemId: 'jf-no-imdb',
				tmdbId: null,
				imdbId: 'tt9999999',
				title: 'Unrelated Server Item',
				itemType: 'movie'
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(1);
		expect(items[0].sourceSystem).toBe('local');
	});

	it('is idempotent - running twice produces same row count and same IDs', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-3', tmdbId: 500, title: 'Idempotent Test' }));
		await testDb.db
			.insert(movieFiles)
			.values(
				createMovieFile({ id: 'mf-3', movieId: 'movie-3' }) as typeof movieFiles.$inferInsert
			);

		const service = getReconciliationService();
		await service.reconcile();
		const itemsAfterFirst = await testDb.db.select().from(storageItems);
		expect(itemsAfterFirst).toHaveLength(1);

		await service.reconcile();
		const itemsAfterSecond = await testDb.db.select().from(storageItems);
		expect(itemsAfterSecond).toHaveLength(1);
		expect(itemsAfterSecond[0].id).toBe(itemsAfterFirst[0].id);
	});

	it('removes stale storage_items when local file is deleted and no server links exist', async () => {
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-4', tmdbId: 600, title: 'Stale' }));
		await testDb.db
			.insert(movieFiles)
			.values(
				createMovieFile({ id: 'mf-4', movieId: 'movie-4' }) as typeof movieFiles.$inferInsert
			);
		const service = getReconciliationService();
		await service.reconcile();
		expect(await testDb.db.select().from(storageItems)).toHaveLength(1);

		// Delete the movie + file
		await testDb.db.delete(movieFiles).where(eq(movieFiles.id, 'mf-4'));
		await testDb.db.delete(movies).where(eq(movies.id, 'movie-4'));

		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(0);
	});

	it('coalesces concurrent triggers via lock - second call returns skipped=true', async () => {
		// Seed enough data that reconcile takes a moment
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-5', tmdbId: 700, title: 'Lock Test' }));
		await testDb.db
			.insert(movieFiles)
			.values(
				createMovieFile({ id: 'mf-5', movieId: 'movie-5' }) as typeof movieFiles.$inferInsert
			);

		const service = getReconciliationService();
		const first = service.reconcile();
		const second = await service.reconcile(); // runs while first is in-flight (synchronous up to first await)
		await first;

		expect(second.skipped).toBe(true);
	});

	it('runs reconcile when library:data-changed fires after start()', async () => {
		// Use a unique tmdbId so we can verify the side effect of the triggered
		// reconcile (rather than spying on private methods).
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-trig', tmdbId: 424242, title: 'Triggered Movie' }));
		await testDb.db
			.insert(movieFiles)
			.values(
				createMovieFile({ id: 'mf-trig', movieId: 'movie-trig' }) as typeof movieFiles.$inferInsert
			);

		const service = getReconciliationService();
		service.start();

		// start() uses setImmediate for both itself and attachListeners(); let
		// those run before emitting the event.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const { libraryMediaEvents } = await import('#lib/server/library/LibraryMediaEvents.js');
		libraryMediaEvents.emitLibraryDataChanged({
			source: 'movie',
			reason: 'test-mutation'
		});

		// Reconcile is triggered via the event handler; allow it to run.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const items = await testDb.db.select().from(storageItems);
		const triggered = items.find((i) => i.tmdbId === 424242);
		expect(triggered).toBeDefined();
		expect(triggered?.title).toBe('Triggered Movie');

		await service.stop();
	});

	it('expands a multi-episode file to per-episode storage_items rows', async () => {
		await testDb.db
			.insert(series)
			.values(createSeries({ id: 'series-ep', tmdbId: 800, title: 'Multi Ep Show' }));
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ep-1',
				seriesId: 'series-ep',
				seasonNumber: 1,
				episodeNumber: 1
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ep-2',
				seriesId: 'series-ep',
				seasonNumber: 1,
				episodeNumber: 2
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodeFiles).values(
			createEpisodeFile({
				id: 'ef-multi',
				seriesId: 'series-ep',
				seasonNumber: 1,
				episodeIds: ['ep-1', 'ep-2']
			}) as typeof episodeFiles.$inferInsert
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(2);
		// Both rows should reference the same episode file
		expect(items.every((i) => i.episodeFileId === 'ef-multi')).toBe(true);
		// And carry distinct episode numbers (1 and 2) rather than collapsing via COALESCE(-1)
		const episodeNumbers = items.map((i) => i.episodeNumber).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(episodeNumbers).toEqual([1, 2]);
	});

	it('marks every episode of a multi-episode file as present when the server reports the file once', async () => {
		await testDb.db
			.insert(series)
			.values(createSeries({ id: 'series-multi-srv', tmdbId: 801, title: 'Multi Ep Show' }));
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ms-ep-1',
				seriesId: 'series-multi-srv',
				seasonNumber: 2,
				episodeNumber: 12
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ms-ep-2',
				seriesId: 'series-multi-srv',
				seasonNumber: 2,
				episodeNumber: 13
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodeFiles).values(
			createEpisodeFile({
				id: 'ef-multi-srv',
				seriesId: 'series-multi-srv',
				seasonNumber: 2,
				episodeIds: ['ms-ep-1', 'ms-ep-2']
			}) as typeof episodeFiles.$inferInsert
		);
		// Server reports the physical file once, under the first episode number only.
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-multi',
				serverId: 'srv-1',
				serverItemId: 'jf-multi',
				tmdbId: 801,
				title: 'Multi Ep Show',
				itemType: 'episode',
				seriesName: 'Multi Ep Show',
				seasonNumber: 2,
				episodeNumber: 12
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.sourceSystem).toBe('both');
			expect(item.episodeFileId).toBe('ef-multi-srv');
		}

		const links = await testDb.db.select().from(storageItemServerLinks);
		expect(links).toHaveLength(2);
		expect(links.every((l) => l.syncedItemId === 'msi-multi')).toBe(true);
	});

	it('marks every episode of a multi-episode file as present when the server reports only the last episode', async () => {
		await testDb.db
			.insert(series)
			.values(createSeries({ id: 'series-multi-last', tmdbId: 802, title: 'Multi Ep Show' }));
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ml-ep-1',
				seriesId: 'series-multi-last',
				seasonNumber: 2,
				episodeNumber: 12
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ml-ep-2',
				seriesId: 'series-multi-last',
				seasonNumber: 2,
				episodeNumber: 13
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodeFiles).values(
			createEpisodeFile({
				id: 'ef-multi-last',
				seriesId: 'series-multi-last',
				seasonNumber: 2,
				episodeIds: ['ml-ep-1', 'ml-ep-2']
			}) as typeof episodeFiles.$inferInsert
		);
		// Some servers report the last episode number of the range as IndexNumber.
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-multi-last',
				serverId: 'srv-1',
				serverItemId: 'jf-multi-last',
				tmdbId: 802,
				title: 'Multi Ep Show',
				itemType: 'episode',
				seriesName: 'Multi Ep Show',
				seasonNumber: 2,
				episodeNumber: 13
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.sourceSystem).toBe('both');
		}
	});

	it('keeps multi-episode rows local-only when the file is absent from the server', async () => {
		await testDb.db
			.insert(series)
			.values(createSeries({ id: 'series-multi-absent', tmdbId: 803, title: 'Multi Ep Show' }));
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ma-ep-1',
				seriesId: 'series-multi-absent',
				seasonNumber: 2,
				episodeNumber: 12
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodes).values(
			createEpisode({
				id: 'ma-ep-2',
				seriesId: 'series-multi-absent',
				seasonNumber: 2,
				episodeNumber: 13
			}) as typeof episodes.$inferInsert
		);
		await testDb.db.insert(episodeFiles).values(
			createEpisodeFile({
				id: 'ef-multi-absent',
				seriesId: 'series-multi-absent',
				seasonNumber: 2,
				episodeIds: ['ma-ep-1', 'ma-ep-2']
			}) as typeof episodeFiles.$inferInsert
		);

		const service = getReconciliationService();
		await service.reconcile();

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.sourceSystem).toBe('local');
		}
		expect(await testDb.db.select().from(storageItemServerLinks)).toHaveLength(0);
	});

	it('links a single storage_items row to multiple media servers', async () => {
		await testDb.db.insert(mediaBrowserServers).values({
			id: 'srv-2',
			name: 'Test Plex',
			serverType: 'plex',
			host: 'http://test2',
			apiKey: 'key2',
			enabled: true
		});
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-ms', tmdbId: 900, title: 'Multi Server' }));
		await testDb.db
			.insert(movieFiles)
			.values(
				createMovieFile({ id: 'mf-ms', movieId: 'movie-ms' }) as typeof movieFiles.$inferInsert
			);
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-a',
				serverId: 'srv-1',
				serverItemId: 'jf-a',
				tmdbId: 900,
				itemType: 'movie'
			})
		);
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-b',
				serverId: 'srv-2',
				serverItemId: 'jf-b',
				tmdbId: 900,
				itemType: 'movie'
			})
		);

		const service = getReconciliationService();
		const result = await service.reconcile();

		expect(result.skipped).toBe(false);
		expect(result.linksUpserted).toBe(2);

		const items = await testDb.db.select().from(storageItems);
		expect(items).toHaveLength(1);
		expect(items[0].sourceSystem).toBe('both');

		const links = await testDb.db.select().from(storageItemServerLinks);
		expect(links).toHaveLength(2);
		const serverIds = links.map((l) => l.serverId).sort();
		expect(serverIds).toEqual(['srv-1', 'srv-2']);
	});

	it('excludes a disabled server from matching - its data is kept, not discarded', async () => {
		await testDb.db.insert(mediaBrowserServers).values({
			id: 'srv-disabled',
			name: 'Disabled Server',
			serverType: 'emby',
			host: 'http://test-disabled',
			apiKey: 'key-disabled',
			enabled: false
		});
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-dis', tmdbId: 910, title: 'Disabled Server Movie' }));
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-dis',
				movieId: 'movie-dis'
			}) as typeof movieFiles.$inferInsert
		);
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-dis',
				serverId: 'srv-disabled',
				serverItemId: 'jf-dis',
				tmdbId: 910,
				itemType: 'movie'
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		// The local movie row exists and is 'local', not 'both' - the
		// disabled server's matching item is invisible to reconciliation.
		const items = await testDb.db.select().from(storageItems).where(eq(storageItems.tmdbId, 910));
		expect(items).toHaveLength(1);
		expect(items[0].sourceSystem).toBe('local');

		// No link to the disabled server - the raw media_server_synced_items
		// row itself is untouched (kept, not discarded) for when it's
		// re-enabled and re-synced.
		expect(await testDb.db.select().from(storageItemServerLinks)).toHaveLength(0);
		const syncedRows = await testDb.db
			.select()
			.from(mediaServerSyncedItems)
			.where(eq(mediaServerSyncedItems.id, 'msi-dis'));
		expect(syncedRows).toHaveLength(1);
	});

	it('removes a stale server link and flips sourceSystem back when a server is disabled after being matched', async () => {
		await testDb.db.insert(mediaBrowserServers).values({
			id: 'srv-toggle',
			name: 'Toggle Server',
			serverType: 'emby',
			host: 'http://test-toggle',
			apiKey: 'key-toggle',
			enabled: true
		});
		await testDb.db
			.insert(movies)
			.values(createMovie({ id: 'movie-toggle', tmdbId: 920, title: 'Toggle Movie' }));
		await testDb.db.insert(movieFiles).values(
			createMovieFile({
				id: 'mf-toggle',
				movieId: 'movie-toggle'
			}) as typeof movieFiles.$inferInsert
		);
		await testDb.db.insert(mediaServerSyncedItems).values(
			createMediaServerItem({
				id: 'msi-toggle',
				serverId: 'srv-toggle',
				serverItemId: 'jf-toggle',
				tmdbId: 920,
				itemType: 'movie'
			})
		);

		const service = getReconciliationService();
		await service.reconcile();

		let items = await testDb.db.select().from(storageItems).where(eq(storageItems.tmdbId, 920));
		expect(items[0].sourceSystem).toBe('both');
		expect(await testDb.db.select().from(storageItemServerLinks)).toHaveLength(1);

		// Disable the server (mirrors MediaBrowserManager.updateServer) and
		// reconcile again.
		await testDb.db
			.update(mediaBrowserServers)
			.set({ enabled: false })
			.where(eq(mediaBrowserServers.id, 'srv-toggle'));
		await service.reconcile();

		items = await testDb.db.select().from(storageItems).where(eq(storageItems.tmdbId, 920));
		expect(items).toHaveLength(1);
		expect(items[0].sourceSystem).toBe('local');
		expect(await testDb.db.select().from(storageItemServerLinks)).toHaveLength(0);
		// The raw synced item is still there, ready for re-enable + re-sync.
		const syncedRows = await testDb.db
			.select()
			.from(mediaServerSyncedItems)
			.where(eq(mediaServerSyncedItems.id, 'msi-toggle'));
		expect(syncedRows).toHaveLength(1);
	});
});

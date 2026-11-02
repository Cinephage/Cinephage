import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';

// Mock the media browser manager so no real HTTP calls happen, and expose the
// mocks so individual tests can control the enabled-server list.
const managerMocks = vi.hoisted(() => ({
	getEnabledServers: vi.fn(),
	testServer: vi.fn()
}));

vi.mock('#lib/server/notifications/mediabrowser/MediaBrowserManager.js', () => ({
	getMediaBrowserManager: () => ({
		getEnabledServers: managerMocks.getEnabledServers,
		testServer: managerMocks.testServer
	})
}));

// Mock the provider factory: the sync service must persist whatever language
// views the provider produced (canonical + raw) without re-processing them.
const providerMocks = vi.hoisted(() => ({
	createStatsProvider: vi.fn()
}));

vi.mock('./providers/index.js', () => ({
	createStatsProvider: providerMocks.createStatsProvider
}));

// Mock the db module with an in-memory sqlite instance.
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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { randomUUID } from 'node:crypto';
import { MediaServerStatsSyncService } from './MediaServerStatsSyncService.js';
import { mediaBrowserServers, mediaServerSyncedItems } from '#lib/server/db/schema.js';
import type { SyncedMediaItem, SyncResult } from './types.js';
import { eq } from 'drizzle-orm';

const SERVER = {
	id: 'srv-language-1',
	name: 'Plex Test',
	host: 'http://plex:32400',
	apiKey: 'token',
	serverType: 'plex'
};

function makeItem(overrides: Partial<SyncedMediaItem> = {}): SyncedMediaItem {
	return {
		serverItemId: 'plex-1',
		tmdbId: 123,
		tvdbId: null,
		imdbId: null,
		title: 'Language Movie',
		year: 2024,
		itemType: 'movie',
		seriesName: null,
		seasonNumber: null,
		episodeNumber: null,
		playCount: 1,
		lastPlayedDate: null,
		playedPercentage: null,
		isPlayed: true,
		videoCodec: 'h264',
		videoProfile: null,
		videoBitDepth: null,
		width: 1920,
		height: 1080,
		isHDR: false,
		hdrFormat: null,
		videoBitrate: null,
		audioCodec: 'dts',
		audioChannels: 6,
		audioChannelLayout: null,
		audioBitrate: null,
		audioLanguages: ['en', 'fr'],
		subtitleLanguages: ['ja'],
		audioLanguagesRaw: ['eng', 'fre'],
		subtitleLanguagesRaw: ['jpn'],
		containerFormat: 'mkv',
		fileSize: 1000,
		bitrate: 20000,
		duration: 7200,
		...overrides
	};
}

function stubProviderResult(result: SyncResult) {
	managerMocks.getEnabledServers.mockResolvedValue([SERVER]);
	managerMocks.testServer.mockResolvedValue({ success: true });
	providerMocks.createStatsProvider.mockReturnValue({
		fetchAllItems: () => Promise.resolve(result)
	});
}

/** Insert the server row so synced_items/runs FKs resolve. */
function seedServerRow() {
	testDb.db
		.insert(mediaBrowserServers)
		.values({
			id: SERVER.id,
			name: SERVER.name,
			serverType: 'plex',
			host: SERVER.host,
			apiKey: SERVER.apiKey
		})
		.onConflictDoNothing()
		.run();
}

afterAll(() => {
	destroyTestDb(testDb);
});

describe('MediaServerStatsSyncService language persistence', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		seedServerRow();
		testDb.db.delete(mediaServerSyncedItems).run();
	});

	it('persists canonical and raw language columns on insert', async () => {
		stubProviderResult({
			items: [makeItem()],
			serverItemIds: new Set(['plex-1']),
			totalOnServer: 1
		});

		const service = new MediaServerStatsSyncService();
		await service.syncServer(SERVER.id);

		const rows = testDb.db
			.select()
			.from(mediaServerSyncedItems)
			.where(eq(mediaServerSyncedItems.serverItemId, 'plex-1'))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0].audioLanguages).toEqual(['en', 'fr']);
		expect(rows[0].subtitleLanguages).toEqual(['ja']);
		expect(rows[0].audioLanguagesRaw).toEqual(['eng', 'fre']);
		expect(rows[0].subtitleLanguagesRaw).toEqual(['jpn']);
	});

	it('overwrites all four language columns on update (server id change)', async () => {
		// Seed a stale row: canonical arrays stored raw by a pre-v140 sync, raws NULL.
		testDb.db.insert(mediaServerSyncedItems).values({
			id: randomUUID(),
			serverId: SERVER.id,
			serverItemId: 'plex-1',
			title: 'Language Movie',
			itemType: 'movie',
			audioLanguages: ['eng', 'fre'],
			subtitleLanguages: ['jpn'],
			audioLanguagesRaw: null,
			subtitleLanguagesRaw: null,
			lastSyncedAt: new Date().toISOString()
		});

		stubProviderResult({
			items: [makeItem({ subtitleLanguages: [], subtitleLanguagesRaw: [] })],
			serverItemIds: new Set(['plex-1']),
			totalOnServer: 1
		});

		const service = new MediaServerStatsSyncService();
		await service.syncServer(SERVER.id);

		const rows = testDb.db
			.select()
			.from(mediaServerSyncedItems)
			.where(eq(mediaServerSyncedItems.serverItemId, 'plex-1'))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0].audioLanguages).toEqual(['en', 'fr']);
		expect(rows[0].audioLanguagesRaw).toEqual(['eng', 'fre']);
		expect(rows[0].subtitleLanguages).toEqual([]);
		expect(rows[0].subtitleLanguagesRaw).toEqual([]);
	});
});

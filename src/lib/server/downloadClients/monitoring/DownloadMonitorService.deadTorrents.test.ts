/**
 * Dead-torrent handling in DownloadMonitorService: the swarm state is stored on
 * the queue row as polls come in, and a torrent the check finds dead is removed,
 * marked failed, blocklisted and searched again right away - for just its
 * movie or episodes, at most once per item per day. Private-tracker torrents
 * only get a warning unless the user opts in.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../../test/db-helper';
import {
	deadDownloadSearches,
	downloadClients,
	downloadQueue,
	episodes,
	monitoringSettings,
	movies,
	series
} from '#lib/server/db/schema.js';
import type { DownloadInfo } from '../core/interfaces.js';
import type { SwarmHealth } from '#lib/types/queue.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const addToBlocklist = vi.fn().mockResolvedValue(undefined);
vi.mock('#lib/server/monitoring/specifications/BlocklistSpecification.js', () => ({
	blocklistService: { addToBlocklist }
}));

const removeDownload = vi.fn().mockResolvedValue(undefined);
vi.mock('../DownloadClientManager', () => ({
	getDownloadClientManager: () => ({
		getClientInstance: vi.fn().mockResolvedValue({ removeDownload })
	})
}));

const searchForMovie = vi.fn().mockResolvedValue({ success: true, releaseName: 'Other.Release' });
const searchBulkEpisodes = vi.fn().mockResolvedValue({ results: [], summary: { grabbed: 1 } });
vi.mock('#lib/server/library/searchOnAdd/index.js', () => ({
	searchOnAdd: { searchForMovie, searchBulkEpisodes }
}));

const { getDownloadMonitor } = await import('./DownloadMonitorService');

const CLIENT_ID = randomUUID();
const MIN = 60_000;
const HOUR = 60 * MIN;

// The private members these tests drive, plus the public queue-button entry point
type Monitor = {
	failBlocklistAndSearch(queueId: string): Promise<boolean>;
	handleDeadTorrents(): Promise<void>;
	trackSwarmHealth(row: typeof downloadQueue.$inferSelect, d: DownloadInfo): Promise<void>;
	lastResearch: Promise<void>;
	deadTorrentSettingsCache: unknown;
};
const monitor = () => getDownloadMonitor() as unknown as Monitor;

function deadHealth(overrides: Partial<SwarmHealth> = {}): SwarmHealth {
	const now = new Date().toISOString();
	return {
		checkedAt: now,
		progressBytes: 65,
		progressAt: new Date(Date.now() - 7 * HOUR).toISOString(),
		seeds: 0,
		peers: 1,
		availability: 0.065,
		isPrivate: false,
		problem: 'no_source',
		strikes: 3,
		strikesNeeded: 3,
		dead: true,
		...overrides
	};
}

async function insertMovie(overrides: Partial<typeof movies.$inferInsert> = {}) {
	const id = randomUUID();
	await testDb.db.insert(movies).values({
		id,
		tmdbId: Math.floor(Math.random() * 1e6),
		title: 'A Movie',
		path: `/movies/${id}`,
		monitored: true,
		hasFile: false,
		...overrides
	});
	return id;
}

async function insertRow(overrides: Partial<typeof downloadQueue.$inferInsert> = {}) {
	const id = randomUUID();
	await testDb.db.insert(downloadQueue).values({
		id,
		downloadClientId: CLIENT_ID,
		downloadId: `hash-${id}`,
		infoHash: `info-${id}`,
		title: `Some.Release.${id}`,
		protocol: 'torrent',
		status: 'stalled',
		progress: '0.065',
		addedAt: new Date(Date.now() - 8 * HOUR).toISOString(),
		...overrides
	});
	return id;
}

async function row(id: string) {
	const [r] = await testDb.db.select().from(downloadQueue).where(eq(downloadQueue.id, id));
	return r;
}

async function setSetting(key: string, value: string) {
	await testDb.db
		.insert(monitoringSettings)
		.values({ key, value })
		.onConflictDoUpdate({ target: monitoringSettings.key, set: { value } });
	monitor().deadTorrentSettingsCache = null;
}

beforeEach(async () => {
	clearTestDb(testDb);
	testDb.db.delete(monitoringSettings).run();
	testDb.db.delete(deadDownloadSearches).run();
	monitor().deadTorrentSettingsCache = null;
	vi.clearAllMocks();
	await testDb.db.insert(downloadClients).values({
		id: CLIENT_ID,
		name: 'qbit',
		implementation: 'qbittorrent',
		enabled: true,
		host: 'localhost',
		port: 8080,
		useSsl: false
	});
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('dead torrents', () => {
	it('removes, fails, blocklists and searches the movie again right away', async () => {
		const movieId = await insertMovie();
		const id = await insertRow({ movieId, swarmHealth: deadHealth() });

		await monitor().handleDeadTorrents();
		await monitor().lastResearch;

		expect(removeDownload).toHaveBeenCalledTimes(1);
		const r = await row(id);
		expect(r.status).toBe('failed');
		expect(r.errorMessage).toMatch(/^Dead torrent - no seeds, 6\.5% available, no progress for 7h/);
		expect(addToBlocklist).toHaveBeenCalledTimes(1);
		expect(searchForMovie).toHaveBeenCalledWith(
			expect.objectContaining({ movieId, bypassMonitoring: false })
		);
	});

	it('leaves a torrent alone until it is dead', async () => {
		await insertRow({
			movieId: await insertMovie(),
			swarmHealth: deadHealth({ strikes: 2, dead: false })
		});

		await monitor().handleDeadTorrents();

		expect(removeDownload).not.toHaveBeenCalled();
		expect(searchForMovie).not.toHaveBeenCalled();
	});

	it('only warns for a private-tracker torrent by default', async () => {
		const id = await insertRow({
			movieId: await insertMovie(),
			swarmHealth: deadHealth({ isPrivate: true })
		});

		await monitor().handleDeadTorrents();

		expect(removeDownload).not.toHaveBeenCalled();
		expect((await row(id)).status).toBe('stalled');
	});

	it('removes a private-tracker torrent when the user opted in', async () => {
		await setSetting('dead_torrent_private_action', 'remove');
		await insertRow({ movieId: await insertMovie(), swarmHealth: deadHealth({ isPrivate: true }) });

		await monitor().handleDeadTorrents();

		expect(removeDownload).toHaveBeenCalledTimes(1);
	});

	it('does nothing when detection is turned off', async () => {
		await setSetting('dead_torrent_enabled', 'false');
		await insertRow({ movieId: await insertMovie(), swarmHealth: deadHealth() });

		await monitor().handleDeadTorrents();

		expect(removeDownload).not.toHaveBeenCalled();
	});

	it('searches the same movie at most once a day', async () => {
		const movieId = await insertMovie();
		await insertRow({ movieId, swarmHealth: deadHealth() });
		await monitor().handleDeadTorrents();
		await monitor().lastResearch;

		// The next grab dies too, the same day.
		await insertRow({ movieId, swarmHealth: deadHealth() });
		await monitor().handleDeadTorrents();
		await monitor().lastResearch;

		expect(removeDownload).toHaveBeenCalledTimes(2);
		expect(searchForMovie).toHaveBeenCalledTimes(1);
	});

	it('searches only the monitored episodes of a dead season pack that still lack a file', async () => {
		const seriesId = randomUUID();
		await testDb.db
			.insert(series)
			.values({ id: seriesId, tmdbId: 77, title: 'A Show', path: '/tv/a-show' });
		const [missing, unmonitored, present] = [randomUUID(), randomUUID(), randomUUID()];
		await testDb.db.insert(episodes).values([
			{ id: missing, seriesId, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: false },
			{
				id: unmonitored,
				seriesId,
				seasonNumber: 1,
				episodeNumber: 2,
				monitored: false,
				hasFile: false
			},
			{ id: present, seriesId, seasonNumber: 1, episodeNumber: 3, monitored: true, hasFile: true }
		]);
		await insertRow({
			seriesId,
			seasonNumber: 1,
			episodeIds: [missing, unmonitored, present],
			swarmHealth: deadHealth()
		});

		await monitor().handleDeadTorrents();
		await monitor().lastResearch;

		expect(searchBulkEpisodes).toHaveBeenCalledWith([missing]);
	});

	it('does not search while automatic search is paused globally', async () => {
		await setSetting('auto_search_globally_paused', 'true');
		await insertRow({ movieId: await insertMovie(), swarmHealth: deadHealth() });

		await monitor().handleDeadTorrents();
		await monitor().lastResearch;

		expect(removeDownload).toHaveBeenCalledTimes(1);
		expect(searchForMovie).not.toHaveBeenCalled();
	});

	it('keeps the swarm clock on the queue row across polls and acts on the third bad check', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t0 = Date.parse('2026-11-01T00:00:00.000Z');
		vi.setSystemTime(t0);
		const movieId = await insertMovie();
		const id = await insertRow({ movieId, addedAt: new Date(t0).toISOString() });
		const dl: DownloadInfo = {
			id: 'h',
			name: 'Some.Release',
			hash: 'h',
			progress: 0.065,
			status: 'stalled',
			size: 1000,
			downloadSpeed: 0,
			uploadSpeed: 0,
			savePath: '/d',
			contentPath: '/d/x',
			canMoveFiles: false,
			canBeRemoved: false,
			downloadedBytes: 65,
			connectedSeeds: 0,
			availability: 0.065
		};

		// One poll every 10 minutes for 6h20m, each reading the row back from the
		// database like the real poll loop does.
		for (let t = t0; t <= t0 + 6 * HOUR + 10 * MIN; t += 10 * MIN) {
			vi.setSystemTime(t);
			await monitor().trackSwarmHealth(await row(id), dl);
			await monitor().handleDeadTorrents();
		}
		expect((await row(id)).swarmHealth).toMatchObject({ strikes: 2, dead: false });
		expect(removeDownload).not.toHaveBeenCalled();

		vi.setSystemTime(t0 + 6 * HOUR + 20 * MIN);
		await monitor().trackSwarmHealth(await row(id), dl);
		await monitor().handleDeadTorrents();
		await monitor().lastResearch;

		expect(removeDownload).toHaveBeenCalledTimes(1);
		expect((await row(id)).status).toBe('failed');
	});
});

describe('failBlocklistAndSearch (queue button)', () => {
	it('fails, blocklists and searches even an unmonitored movie, ignoring the daily limit', async () => {
		const movieId = await insertMovie({ monitored: false });
		await testDb.db
			.insert(deadDownloadSearches)
			.values({ targetKey: `movie:${movieId}`, searchedAt: new Date().toISOString() });
		const id = await insertRow({ movieId, status: 'downloading', swarmHealth: null });

		expect(await monitor().failBlocklistAndSearch(id)).toBe(true);
		await monitor().lastResearch;

		expect(removeDownload).toHaveBeenCalledTimes(1);
		expect(addToBlocklist).toHaveBeenCalledTimes(1);
		expect((await row(id)).errorMessage).toBe('Marked failed by user');
		expect(searchForMovie).toHaveBeenCalledWith(
			expect.objectContaining({ movieId, bypassMonitoring: true })
		);
	});

	it('returns false for an unknown queue item', async () => {
		expect(await monitor().failBlocklistAndSearch(randomUUID())).toBe(false);
	});
});

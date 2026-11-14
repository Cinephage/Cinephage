import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db-helper.js';
import {
	acquisitionIntents,
	downloadClients,
	downloadHistory,
	downloadQueue,
	series
} from '#lib/server/db/schema.js';

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

const { recheckResolvedIdentity } = await import('./identity-recheck.js');
const { acquisitionService } = await import('#lib/server/acquisition/AcquisitionService.js');

const HASH = 'b1c2d3e4f5061728394a5b6c7d8e9f0012345678';

function resetDb() {
	testDb.sqlite.exec(`
		DELETE FROM acquisition_reservations;
		DELETE FROM acquisition_intents;
		DELETE FROM download_queue;
		DELETE FROM download_history;
		DELETE FROM download_clients;
		DELETE FROM series;
	`);
	// The rows under test point at real media and client rows; the schema enforces it.
	testDb.db
		.insert(series)
		.values({ id: 'series-1', tmdbId: 990001, title: 'Show', path: 'Show' })
		.run();
	testDb.db
		.insert(downloadClients)
		.values({
			id: 'client-1',
			name: 'qBittorrent',
			implementation: 'qbittorrent',
			host: 'localhost',
			port: 8080
		})
		.run();
}

function createTvIntent(episodeIds: string[], seriesId = 'series-1'): string {
	const result = acquisitionService.createIntent({
		mediaType: 'tv',
		seriesId,
		seasonNumber: 1,
		episodeIds,
		qualitySlot: '1080p',
		protocol: 'torrent',
		releaseTitle: 'Show.S01.Pack-GRP',
		source: 'automatic'
	});
	if (!result.ok) throw new Error(`intent refused: ${result.kind}`);
	return result.intentId;
}

function addImportedHistory(episodeIds: string[] | null) {
	testDb.db
		.insert(downloadHistory)
		.values({
			title: 'Show.S01.Pack-GRP',
			infoHash: HASH,
			downloadId: HASH,
			status: 'imported',
			seriesId: 'series-1',
			episodeIds
		})
		.run();
}

describe('recheckResolvedIdentity', () => {
	beforeEach(resetDb);

	it('blocks a pack that already delivered every reserved episode', async () => {
		const intentId = createTvIntent(['ep-1', 'ep-2']);
		addImportedHistory(['ep-1', 'ep-2']);

		const result = await recheckResolvedIdentity(intentId, HASH);

		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('already imported');
	});

	it('allows the same pack when it still owes a reserved episode', async () => {
		const intentId = createTvIntent(['ep-1', 'ep-3']);
		addImportedHistory(['ep-1', 'ep-2']);

		const result = await recheckResolvedIdentity(intentId, HASH);

		expect(result.blocked).toBe(false);
	});

	it('blocks while a live queue row holds the hash', async () => {
		const intentId = createTvIntent(['ep-3']);
		testDb.db
			.insert(downloadQueue)
			.values({
				downloadClientId: 'client-1',
				downloadId: HASH,
				infoHash: HASH,
				title: 'Show.S01.Pack-GRP',
				status: 'completed'
			})
			.run();

		const result = await recheckResolvedIdentity(intentId, HASH);

		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('already importing');
	});

	it('blocks a second active acquisition of the same release identity', async () => {
		const first = createTvIntent(['ep-1']);
		await recheckResolvedIdentity(first, HASH);

		const second = createTvIntent(['ep-2']);
		const result = await recheckResolvedIdentity(second, HASH);

		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('already being acquired');
	});

	it('leaves the intent identity recorded', async () => {
		const intentId = createTvIntent(['ep-1']);

		await recheckResolvedIdentity(intentId, HASH);

		const row = testDb.db.select().from(acquisitionIntents).all()[0];
		expect(row.identityKind).toBe('info_hash');
		expect(row.identityValue).toBe(HASH);
	});
});

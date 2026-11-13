import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../../../test/db-helper.js';
import { makeGrabDecisionContext } from '../../../../../test/fixtures/filters.js';
import { downloadClients, downloadHistory, downloadQueue, movies, series } from '#lib/server/db/schema.js';

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

const { DuplicateHashStage } = await import('./DuplicateHashStage.js');

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** The rows under test point at real media and client rows; the schema enforces it. */
function seedParents() {
	testDb.db
		.insert(series)
		.values({ id: 'series-1', tmdbId: 990001, title: 'Show', path: 'Show' })
		.run();
	testDb.db
		.insert(movies)
		.values({ id: 'movie-1', tmdbId: 990002, title: 'Movie', path: 'Movie' })
		.run();
	testDb.db
		.insert(downloadClients)
		.values({ id: 'client-1', name: 'qBittorrent', implementation: 'qbittorrent', host: 'localhost', port: 8080 })
		.run();
}

function resetDb() {
	testDb.sqlite.exec(
		'DELETE FROM download_queue; DELETE FROM download_history; DELETE FROM series; DELETE FROM movies; DELETE FROM download_clients;'
	);
	seedParents();
}

function addHistory(episodeIds: string[] | null) {
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

function addQueueRow(status: string) {
	testDb.db
		.insert(downloadQueue)
		.values({
			downloadClientId: 'client-1',
			downloadId: HASH,
			infoHash: HASH,
			title: 'Show.S01.Pack-GRP',
			status
		})
		.run();
}

function episodeContext(episodeId: string) {
	return makeGrabDecisionContext({
		release: { title: 'Show.S01.Pack-GRP', infoHash: HASH, protocol: 'torrent' },
		target: { type: 'episode', episodeId, seriesId: 'series-1' }
	});
}

describe('DuplicateHashStage', () => {
	const stage = new DuplicateHashStage();

	beforeEach(resetDb);

	it('rejects a hash already imported for this episode', async () => {
		addHistory(['ep-1', 'ep-2']);

		const result = await stage.evaluate(episodeContext('ep-2'));

		expect(result.accepted).toBe(false);
		expect(result.details).toEqual({ rejectionType: 'duplicate_hash', infoHash: HASH });
	});

	it('accepts the same pack for an episode it has not delivered yet', async () => {
		addHistory(['ep-1', 'ep-2']);

		const result = await stage.evaluate(episodeContext('ep-3'));

		expect(result.accepted).toBe(true);
	});

	it('rejects while a live queue row holds the hash', async () => {
		addQueueRow('downloading');

		const result = await stage.evaluate(episodeContext('ep-1'));

		expect(result.accepted).toBe(false);
		expect(result.reason).toContain('already in download queue');
	});

	it('does not let a failed queue row block the grab', async () => {
		addQueueRow('failed');

		const result = await stage.evaluate(episodeContext('ep-1'));

		expect(result.accepted).toBe(true);
	});

	it('still rejects an imported movie release', async () => {
		testDb.db
			.insert(downloadHistory)
			.values({
				title: 'Movie.2024.1080p-GRP',
				infoHash: HASH,
				downloadId: HASH,
				status: 'imported',
				movieId: 'movie-1'
			})
			.run();

		const result = await stage.evaluate(
			makeGrabDecisionContext({
				release: { title: 'Movie.2024.1080p-GRP', infoHash: HASH, protocol: 'torrent' },
				target: { type: 'movie', movieId: 'movie-1' }
			})
		);

		expect(result.accepted).toBe(false);
	});

	it('does not run when the hash is not known before resolution', async () => {
		const ctx = makeGrabDecisionContext({
			release: { title: 'Show.S01.1080p-GRP', downloadUrl: 'https://example.test/dl.php?t=1' }
		});

		expect(stage.isEnabled(ctx)).toBe(false);
	});
});

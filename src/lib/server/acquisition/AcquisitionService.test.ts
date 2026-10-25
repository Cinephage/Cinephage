import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';
import {
	acquisitionIntents,
	acquisitionReservations,
	downloadClients,
	downloadQueue,
	movies,
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

const { acquisitionService } = await import('./AcquisitionService.js');

function resetDb() {
	testDb.sqlite.exec(`
		DELETE FROM acquisition_reservations;
		DELETE FROM acquisition_intents;
		DELETE FROM download_queue;
		DELETE FROM download_clients;
		DELETE FROM movies;
		DELETE FROM series;
	`);

	// FK enforcement is on: intents reference real library rows.
	for (const movie of [
		{ id: 'movie-1', tmdbId: 101, title: 'Alpha Movie', path: 'Alpha Movie (2026)' },
		{ id: 'movie-2', tmdbId: 102, title: 'Beta Movie', path: 'Beta Movie (2026)' }
	]) {
		testDb.db.insert(movies).values(movie).run();
	}
	testDb.db
		.insert(series)
		.values({ id: 'series-1', tmdbId: 201, title: 'Show One', path: 'Show One' })
		.run();
	testDb.db
		.insert(series)
		.values({ id: 'series-2', tmdbId: 202, title: 'Show Two', path: 'Show Two' })
		.run();
}

function movieIntent(
	overrides: Partial<Parameters<typeof acquisitionService.createIntent>[0]> = {}
) {
	return acquisitionService.createIntent({
		mediaType: 'movie',
		movieId: 'movie-1',
		qualitySlot: 'single',
		protocol: 'torrent',
		identity: { kind: 'info_hash', value: 'hash-1' },
		releaseTitle: 'Movie.2026.1080p.WEB-DL',
		source: 'automatic',
		upgradeStatus: 'new',
		...overrides
	});
}

describe('AcquisitionService', () => {
	beforeEach(() => {
		resetDb();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('creates an active intent and reserves the movie slot', () => {
		const result = movieIntent();

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const intent = testDb.db
			.select()
			.from(acquisitionIntents)
			.all()
			.find((row) => row.id === result.intentId);
		expect(intent?.status).toBe('active');
		expect(intent?.upgradeStatus).toBe('new');

		const reservations = testDb.db
			.select()
			.from(acquisitionReservations)
			.all()
			.filter((row) => row.intentId === result.intentId);
		expect(reservations).toHaveLength(1);
		expect(reservations[0]?.targetKey).toBe('movie:movie-1:single');
		expect(reservations[0]?.releasedAt).toBeNull();
	});

	it('blocks a second acquisition of the same movie slot with conflict details', () => {
		expect(movieIntent().ok).toBe(true);

		const second = movieIntent({
			identity: { kind: 'info_hash', value: 'hash-2' },
			releaseTitle: 'Movie.2026.2160p.WEB-DL'
		});

		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.kind).toBe('slot_conflict');
		expect(second.conflict.targetKey).toBe('movie:movie-1:single');
		expect(second.conflict.releaseTitle).toBe('Movie.2026.1080p.WEB-DL');
		expect(second.conflict.status).toBe('active');
	});

	it('allows parallel acquisitions of different quality buckets (multi-quality)', () => {
		expect(
			movieIntent({ qualitySlot: '1080p', identity: { kind: 'info_hash', value: 'a' } }).ok
		).toBe(true);
		expect(
			movieIntent({ qualitySlot: '2160p', identity: { kind: 'info_hash', value: 'b' } }).ok
		).toBe(true);
	});

	it('blocks the same release identity across different targets', () => {
		expect(
			movieIntent({ movieId: 'movie-1', identity: { kind: 'info_hash', value: 'same-hash' } }).ok
		).toBe(true);

		const second = movieIntent({
			movieId: 'movie-2',
			identity: { kind: 'info_hash', value: 'same-hash' }
		});

		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.kind).toBe('identity_conflict');
		expect(second.conflict.targetKey).toBe('identity');
	});

	it('releases slots on completion, allowing a new acquisition', () => {
		const first = movieIntent();
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		acquisitionService.completeIntent(first.intentId);

		const intent = testDb.db
			.select()
			.from(acquisitionIntents)
			.all()
			.find((row) => row.id === first.intentId);
		expect(intent?.status).toBe('completed');

		const reservation = testDb.db
			.select()
			.from(acquisitionReservations)
			.all()
			.find((row) => row.intentId === first.intentId);
		expect(reservation?.releasedAt).not.toBeNull();

		expect(movieIntent({ identity: { kind: 'info_hash', value: 'hash-next' } }).ok).toBe(true);
	});

	it('releases slots on failure and cancellation', () => {
		const a = movieIntent({ identity: { kind: 'info_hash', value: 'a' } });
		const b = movieIntent({ qualitySlot: '2160p', identity: { kind: 'info_hash', value: 'b' } });
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;

		acquisitionService.failIntent(a.intentId, 'client error');
		acquisitionService.cancelIntent(b.intentId, 'user removed');

		expect(movieIntent({ identity: { kind: 'info_hash', value: 'c' } }).ok).toBe(true);
		expect(
			movieIntent({ qualitySlot: '2160p', identity: { kind: 'info_hash', value: 'd' } }).ok
		).toBe(true);
	});

	it('reserves per-episode keys and blocks only overlapping episodes', () => {
		const seasonPack = acquisitionService.createIntent({
			mediaType: 'tv',
			seriesId: 'series-1',
			seasonNumber: 1,
			episodeIds: ['ep-1', 'ep-2'],
			qualitySlot: 'episodes',
			protocol: 'torrent',
			releaseTitle: 'Show.S01.1080p',
			source: 'automatic'
		});
		expect(seasonPack.ok).toBe(true);
		if (!seasonPack.ok) return;

		const keys = testDb.db
			.select()
			.from(acquisitionReservations)
			.all()
			.filter((row) => row.intentId === seasonPack.intentId)
			.map((row) => row.targetKey)
			.sort();
		expect(keys).toEqual(['episode:ep-1', 'episode:ep-2']);

		// Overlapping episode conflicts.
		const overlapping = acquisitionService.createIntent({
			mediaType: 'tv',
			seriesId: 'series-1',
			episodeIds: ['ep-2'],
			qualitySlot: 'episodes',
			protocol: 'torrent',
			releaseTitle: 'Show.S01E02.1080p',
			source: 'automatic'
		});
		expect(overlapping.ok).toBe(false);
		if (!overlapping.ok) {
			expect(overlapping.kind).toBe('slot_conflict');
			expect(overlapping.conflict.targetKey).toBe('episode:ep-2');
		}

		// A different series does not conflict.
		const otherSeries = acquisitionService.createIntent({
			mediaType: 'tv',
			seriesId: 'series-2',
			episodeIds: ['ep-9'],
			qualitySlot: 'episodes',
			protocol: 'torrent',
			releaseTitle: 'Other.Show.S01E01.1080p',
			source: 'automatic'
		});
		expect(otherSeries.ok).toBe(true);
	});

	it('detects identity conflicts when identity is resolved after creation (setIdentity)', () => {
		const first = movieIntent({ identity: undefined });
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		// A second grab for another movie with unknown identity succeeds at first…
		const second = movieIntent({
			movieId: 'movie-2',
			identity: undefined
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		// …but when the first resolves the hash, the second's resolution conflicts.
		expect(
			acquisitionService.setIdentity(first.intentId, { kind: 'info_hash', value: 'late-hash' }).ok
		).toBe(true);
		const lateConflict = acquisitionService.setIdentity(second.intentId, {
			kind: 'info_hash',
			value: 'late-hash'
		});
		expect(lateConflict.ok).toBe(false);
		if (!lateConflict.ok) {
			expect(lateConflict.conflict.releaseTitle).toBe('Movie.2026.1080p.WEB-DL');
		}
	});

	it('rejects TV intents with an empty episode scope', () => {
		expect(() =>
			acquisitionService.createIntent({
				mediaType: 'tv',
				seriesId: 'series-1',
				episodeIds: [],
				qualitySlot: 'episodes',
				protocol: 'torrent',
				releaseTitle: 'Show',
				source: 'automatic'
			})
		).toThrow(/non-empty/);
	});

	it('attaches the queue id and exposes active reservation keys', () => {
		const created = movieIntent();
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		acquisitionService.attachQueueId(created.intentId, 'queue-7');

		const intent = testDb.db
			.select()
			.from(acquisitionIntents)
			.all()
			.find((row) => row.id === created.intentId);
		expect(intent?.queueId).toBe('queue-7');

		expect(acquisitionService.getActiveReservationKeys(['movie:movie-1:single'])).toEqual([
			'movie:movie-1:single'
		]);
		expect(acquisitionService.getActiveReservationKeys(['movie:movie-9:single'])).toEqual([]);
	});

	it('reconcileStaleIntents fails intents whose queue row is gone or terminal, releasing slots', () => {
		const gone = movieIntent({
			qualitySlot: 'single',
			identity: { kind: 'info_hash', value: 'gone-1' }
		});
		const removed = movieIntent({
			qualitySlot: '2160p',
			identity: { kind: 'info_hash', value: 'gone-2' }
		});
		const healthy = movieIntent({
			qualitySlot: '1080p',
			identity: { kind: 'info_hash', value: 'live-1' }
		});
		expect(gone.ok && removed.ok && healthy.ok).toBe(true);
		if (!gone.ok || !removed.ok || !healthy.ok) return;

		acquisitionService.attachQueueId(gone.intentId, 'queue-vanished');
		acquisitionService.attachQueueId(removed.intentId, 'queue-removed');
		acquisitionService.attachQueueId(healthy.intentId, 'queue-alive');

		// The "alive" transport row must actually exist for the healthy intent.
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
		testDb.db
			.insert(downloadQueue)
			.values({
				id: 'queue-alive',
				downloadClientId: 'client-1',
				downloadId: 'dl-1',
				title: 'Movie.2026.1080p.WEB-DL',
				protocol: 'torrent',
				movieId: 'movie-1',
				status: 'downloading'
			})
			.run();

		// No queue row at all for 'queue-vanished' (crash between grab and
		// queue write); terminal row for 'queue-removed'.

		const reconciled = acquisitionService.reconcileStaleIntents();
		expect(reconciled).toBe(2);

		const intents = testDb.db.select().from(acquisitionIntents).all();
		const byId = new Map(intents.map((row) => [row.id, row]));
		expect(byId.get(gone.intentId)?.status).toBe('failed');
		expect(byId.get(removed.intentId)?.status).toBe('failed');
		expect(byId.get(healthy.intentId)?.status).toBe('active');

		// Freed slots are grabbable again.
		expect(movieIntent({ identity: { kind: 'info_hash', value: 'next-1' } }).ok).toBe(true);
		expect(
			movieIntent({ qualitySlot: '2160p', identity: { kind: 'info_hash', value: 'next-2' } }).ok
		).toBe(true);
	});

	describe('releaseUnmatchedQueueItems', () => {
		beforeEach(() => {
			resetDb();
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
		});

		function insertQueueRow(overrides: Partial<typeof downloadQueue.$inferInsert> = {}) {
			const id = overrides.id ?? 'queue-1';
			testDb.db
				.insert(downloadQueue)
				.values({
					id,
					downloadClientId: 'client-1',
					downloadId: `dl-${id}`,
					title: 'Some.Release.2026',
					protocol: 'torrent',
					movieId: 'movie-1',
					status: 'seeding-imported',
					...overrides
				})
				.run();
			return id;
		}

		// Issue: unmatching a movie/series previously inferred "came from
		// track/enroll" from indexerId being null, which also matches a
		// legitimate arr_push-pushed grab (releasePush.ts never sets indexerId
		// either) - releaseUnmatchedQueueItems must only act on rows explicitly
		// stamped with `origin`.
		it('releases rows stamped with origin=unmatched_track or unmatched_enroll', () => {
			insertQueueRow({ id: 'queue-track', origin: 'unmatched_track' });
			insertQueueRow({ id: 'queue-enroll', origin: 'unmatched_enroll' });

			const result = acquisitionService.releaseUnmatchedQueueItems(
				{ movieId: 'movie-1' },
				'files unmatched from library'
			);

			expect(result).toEqual({ released: 2, heldBack: 0 });
			expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(0);
		});

		it('never releases a legitimate arr_push-shaped row (indexerId null, origin null)', () => {
			insertQueueRow({ id: 'queue-arr-push', origin: null, indexerId: null, protocol: 'torrent' });

			const result = acquisitionService.releaseUnmatchedQueueItems(
				{ movieId: 'movie-1' },
				'files unmatched from library'
			);

			expect(result).toEqual({ released: 0, heldBack: 0 });
			expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(1);
		});

		it('leaves importing/postprocessing rows alone instead of deleting them mid-import', () => {
			insertQueueRow({ id: 'queue-importing', origin: 'unmatched_enroll', status: 'importing' });
			insertQueueRow({
				id: 'queue-postprocessing',
				origin: 'unmatched_enroll',
				status: 'postprocessing'
			});

			const result = acquisitionService.releaseUnmatchedQueueItems(
				{ movieId: 'movie-1' },
				'files unmatched from library'
			);

			expect(result).toEqual({ released: 0, heldBack: 2 });
			expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(2);
		});

		it('releases rows in other statuses (queued, downloading, failed, stalled)', () => {
			for (const status of ['queued', 'downloading', 'failed', 'stalled'] as const) {
				insertQueueRow({ id: `queue-${status}`, origin: 'unmatched_track', status });
			}

			const result = acquisitionService.releaseUnmatchedQueueItems(
				{ movieId: 'movie-1' },
				'files unmatched from library'
			);

			expect(result).toEqual({ released: 4, heldBack: 0 });
		});

		it('scopes by seriesId when given one, independent of movie-scoped rows', () => {
			insertQueueRow({ id: 'queue-movie', origin: 'unmatched_track', movieId: 'movie-1' });
			insertQueueRow({
				id: 'queue-series',
				origin: 'unmatched_track',
				movieId: null,
				seriesId: 'series-1'
			});

			const result = acquisitionService.releaseUnmatchedQueueItems(
				{ seriesId: 'series-1' },
				'files unmatched from library'
			);

			expect(result).toEqual({ released: 1, heldBack: 0 });
			const remaining = testDb.db.select().from(downloadQueue).all();
			expect(remaining.map((r) => r.id)).toEqual(['queue-movie']);
		});
	});
});

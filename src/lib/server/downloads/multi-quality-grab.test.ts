import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import {
	downloadClients,
	downloadHistory,
	downloadQueue,
	movieFiles,
	movies
} from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

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

// Scoring is not under test here; return an always-acceptable result whose
// resolution is taken from the real ReleaseParser output ScoringStage passes in.
vi.mock('#lib/server/quality/QualityFilter.js', () => ({
	qualityFilter: {
		getProfile: vi.fn().mockResolvedValue(null),
		getDefaultScoringProfile: vi.fn().mockResolvedValue({
			id: 'balanced',
			name: 'Balanced',
			minScore: 0,
			upgradesAllowed: true,
			formatScores: {},
			allowedProtocols: ['torrent', 'usenet', 'streaming']
		}),
		calculateEnhancedScore: vi.fn((parsed: { resolution?: string }) => ({
			scoringResult: {
				releaseName: '',
				profile: 'Balanced',
				resolution: parsed.resolution,
				totalScore: 100,
				matchedFormats: [],
				breakdown: {},
				meetsMinimum: true,
				isBanned: false,
				bannedReasons: [],
				sizeRejected: false,
				sizeRejectionReason: undefined,
				protocolRejected: false,
				protocolRejectionReason: undefined
			}
		}))
	}
}));

// Stub the torrent handler so grab() persists a REAL download_queue row for each
// grab. This is what makes the second grab's occupancy check observe bucket A as
// occupied - the exact scenario the bucket-aware fix must not over-block.
vi.mock('./handlers/TorrentHandler.js', () => ({
	TorrentHandler: class {
		async handle(
			request: { release: { title: string; infoHash?: string } },
			resolved: { movieId?: string }
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			const { db } = await import('#lib/server/db/index.js');
			const { downloadQueue } = await import('#lib/server/db/schema.js');
			const { ReleaseParser } = await import('#lib/server/indexers/parser/ReleaseParser.js');
			const parser = new ReleaseParser();
			const parsed = parser.parse(request.release.title);
			const id = `queue-${resolved.movieId}-${parsed.resolution}`;
			await db.insert(downloadQueue).values({
				id,
				downloadClientId: 'client-1',
				downloadId: `hash-${id}`,
				infoHash: request.release.infoHash,
				title: request.release.title,
				movieId: resolved.movieId,
				status: 'queued',
				protocol: 'torrent',
				quality: { resolution: parsed.resolution }
			});
			return {
				success: true,
				queueId: id,
				hash: `hash-${id}`,
				clientId: 'client-1',
				clientName: 'qBittorrent',
				wasDuplicate: false
			};
		}
	}
}));

const { grabService } = await import('./GrabService.js');

function resetDb() {
	testDb.sqlite.exec(`
		DELETE FROM acquisition_reservations;
		DELETE FROM acquisition_intents;
		DELETE FROM download_queue;
		DELETE FROM download_history;
		DELETE FROM movie_files;
		DELETE FROM movies;
		DELETE FROM download_clients;
	`);
}

function seedMovieAndClient() {
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
		.insert(movies)
		.values({
			id: 'movie-1',
			tmdbId: 100,
			title: 'Test Movie',
			path: 'Test Movie (2026)',
			desiredQualities: ['2160p', '1080p']
		})
		.run();
	testDb.db
		.insert(movies)
		.values({
			id: 'movie-2',
			tmdbId: 101,
			title: 'Test Movie Two',
			path: 'Test Movie Two (2026)',
			desiredQualities: ['1080p']
		})
		.run();
}

describe('GrabService multi-quality two-bucket grab (integration)', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		resetDb();
		seedMovieAndClient();
	});

	it('accepts a 1080p grab while a 2160p download is already queued', async () => {
		const options = {
			force: false,
			skipBlocklist: true,
			isAutomatic: true,
			allowSidegrade: false,
			skipDelay: true
		};

		// Bucket A: 2160p grab must succeed and create a real download_queue row.
		const first = await grabService.grab({
			release: {
				title: 'Test.Movie.2026.2160p.WEB-DL.DDP5.1.H.264-GROUP',
				protocol: 'torrent',
				size: 5_000_000_000
			},
			target: { type: 'movie', movieId: 'movie-1' },
			options
		});
		expect(first.success).toBe(true);

		// Sanity: the 2160p download really is queued, so the next grab has
		// something concrete that the old (pre-fix) logic would block on.
		const queued2160p = await testDb.db
			.select({ id: downloadQueue.id })
			.from(downloadQueue)
			.where(eq(downloadQueue.movieId, 'movie-1'));
		expect(queued2160p).toHaveLength(1);

		// Bucket B: 1080p grab must NOT be rejected by MediaOccupancyStage.
		const second = await grabService.grab({
			release: {
				title: 'Test.Movie.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				protocol: 'torrent',
				size: 4_000_000_000
			},
			target: { type: 'movie', movieId: 'movie-1' },
			options
		});
		expect(second.success).toBe(true);
		expect(second.decision.rejectionType).not.toBe('media_occupied');

		// Both buckets now have active downloads.
		const allQueued = await testDb.db
			.select({ id: downloadQueue.id })
			.from(downloadQueue)
			.where(eq(downloadQueue.movieId, 'movie-1'));
		expect(allQueued).toHaveLength(2);
	});

	it('serializes the same hash across different media targets', async () => {
		const infoHash = '0123456789abcdef0123456789abcdef01234567';
		const options = {
			force: false,
			skipBlocklist: true,
			isAutomatic: false,
			allowSidegrade: false,
			skipDelay: true
		};

		const [first, second] = await Promise.all(
			['movie-1', 'movie-2'].map((movieId) =>
				grabService.grab({
					release: {
						title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
						infoHash,
						protocol: 'torrent',
						size: 4_000_000_000
					},
					target: { type: 'movie', movieId },
					options
				})
			)
		);

		expect([first, second].filter((result) => result.success)).toHaveLength(1);
		expect([first, second].find((result) => !result.success)?.decision.rejectionType).toBe(
			'duplicate_hash'
		);
		expect(
			testDb.db.select().from(downloadQueue).where(eq(downloadQueue.infoHash, infoHash)).all()
		).toHaveLength(1);
	});

	it('rejects an already imported hash when the media file still exists', async () => {
		const infoHash = 'abcdef0123456789abcdef0123456789abcdef01';
		testDb.db
			.insert(movieFiles)
			.values({
				id: 'file-existing',
				movieId: 'movie-1',
				relativePath: 'Test Movie (2026)/movie.1080p.mkv',
				quality: { resolution: '1080p' }
			})
			.run();
		testDb.db
			.insert(downloadHistory)
			.values({
				id: 'history-existing',
				downloadId: 'provider-item-1',
				infoHash,
				title: 'Test.Movie.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				movieId: 'movie-1',
				protocol: 'torrent',
				status: 'imported'
			})
			.run();

		const result = await grabService.grab({
			release: {
				title: 'Test.Movie.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				infoHash,
				protocol: 'torrent',
				size: 4_000_000_000
			},
			target: { type: 'movie', movieId: 'movie-1' },
			options: {
				force: false,
				skipBlocklist: true,
				isAutomatic: false,
				allowSidegrade: false,
				skipDelay: true
			}
		});

		expect(result.success).toBe(false);
		expect(result.decision.rejectionType).toBe('duplicate_hash');
		expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(0);
	});

	it('rejects an imported hash even when the target has no file or differs', async () => {
		const infoHash = 'abcdef0123456789abcdef0123456789abcdef01';
		testDb.db
			.insert(downloadHistory)
			.values({
				id: 'history-existing',
				downloadId: 'provider-item-1',
				infoHash,
				title: 'Test.Movie.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				movieId: 'movie-1',
				protocol: 'torrent',
				status: 'imported'
			})
			.run();

		const result = await grabService.grab({
			release: {
				title: 'Test.Movie.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				infoHash,
				protocol: 'torrent',
				size: 4_000_000_000
			},
			target: { type: 'movie', movieId: 'movie-2' },
			options: {
				force: false,
				skipBlocklist: true,
				isAutomatic: false,
				allowSidegrade: false,
				skipDelay: true
			}
		});

		expect(result.success).toBe(false);
		expect(result.decision.rejectionType).toBe('duplicate_hash');
		expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(0);
	});

	it('allows a re-grab when only a failed row matches the magnet hash', async () => {
		const infoHash = '0123456789abcdef0123456789abcdef01234567';
		testDb.db
			.insert(downloadQueue)
			.values({
				id: 'queue-failed',
				downloadClientId: 'client-1',
				downloadId: infoHash,
				infoHash,
				title: 'Test.Movie.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				movieId: 'movie-1',
				status: 'failed',
				protocol: 'torrent'
			})
			.run();

		const result = await grabService.grab({
			release: {
				title: 'Test.Movie.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP',
				magnetUrl: `magnet:?xt=urn:btih:${infoHash}`,
				protocol: 'torrent',
				size: 4_000_000_000
			},
			target: { type: 'movie', movieId: 'movie-1' },
			options: {
				force: false,
				skipBlocklist: true,
				isAutomatic: false,
				allowSidegrade: false,
				skipDelay: true
			}
		});

		// A failed attempt is retryable: the duplicate-hash stage must not treat
		// it as a live duplicate (addToQueue deliberately excludes failed rows
		// so they can be resurrected).
		expect(result.success).toBe(true);
		const rows = testDb.db.select().from(downloadQueue).all();
		expect(rows).toHaveLength(2);
		expect(rows.some((row) => row.status === 'failed')).toBe(true);
		expect(rows.some((row) => row.status === 'queued')).toBe(true);
	});
});

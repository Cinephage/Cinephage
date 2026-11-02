import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../test/db-helper';
import { callHandler } from '../../../../test/api-helper';
import { randomUUID } from 'node:crypto';
import {
	rejectedReleases,
	importFailures,
	renamingFailures,
	unmatchedFiles,
	downloadClients
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

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const { GET, PATCH } = await import('./+server');

function makeUrl(type: string, params: Record<string, string> = {}): string {
	const url = new URL(`http://localhost/api/reports/${type}`);
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v);
	}
	return url.toString();
}

function opts(type: string, params: Record<string, string> = {}) {
	return { url: makeUrl(type, params), params: { type }, auth: 'admin' as const };
}

describe('Reports [type] API', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
		testDb.db.delete(rejectedReleases).run();
		testDb.db.delete(importFailures).run();
		testDb.db.delete(renamingFailures).run();
	});

	// -------------------------------------------------------------------------
	// Unknown type
	// -------------------------------------------------------------------------
	describe('GET unknown type', () => {
		it('returns 400 for unknown report type', async () => {
			const { status, data } = await callHandler(GET, 'GET', undefined, opts('bogus-type'));
			expect(status).toBe(400);
			expect((data as any).success).toBe(false);
		});
	});

	describe('PATCH unknown type', () => {
		it('returns 400 for unknown report type', async () => {
			const { status, data } = await callHandler(
				PATCH,
				'PATCH',
				{ ids: [randomUUID()], status: 'resolved' },
				opts('bogus-type')
			);
			expect(status).toBe(400);
			expect((data as any).success).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// rejected-releases
	// -------------------------------------------------------------------------
	describe('GET rejected-releases', () => {
		it('returns records, excluding resolved by default', async () => {
			const id1 = randomUUID();
			const id2 = randomUUID();
			const now = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{ id: id1, releaseTitle: 'Movie A', status: 'rejected', rejectedAt: now },
					{ id: id2, releaseTitle: 'Movie B', status: 'resolved', rejectedAt: now }
				])
				.run();

			const { status, data } = await callHandler(GET, 'GET', undefined, opts('rejected-releases'));
			expect(status).toBe(200);
			expect((data as any).success).toBe(true);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].id).toBe(id1);
		});

		it('returns resolved records when status filter is set', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{ id: randomUUID(), releaseTitle: 'A', status: 'resolved', rejectedAt: now },
					{ id: randomUUID(), releaseTitle: 'B', status: 'rejected', rejectedAt: now }
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { status: 'resolved' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].status).toBe('resolved');
		});

		it('filters by search term in releaseTitle', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{
						id: randomUUID(),
						releaseTitle: 'Interstellar.1080p',
						status: 'rejected',
						rejectedAt: now
					},
					{ id: randomUUID(), releaseTitle: 'Avatar.4K', status: 'rejected', rejectedAt: now }
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { search: 'Interstellar' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].releaseTitle).toBe('Interstellar.1080p');
		});

		it('filters by search term in mediaTitle', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{
						id: randomUUID(),
						releaseTitle: 'release.1080p',
						mediaTitle: 'Dune',
						status: 'rejected',
						rejectedAt: now
					},
					{
						id: randomUUID(),
						releaseTitle: 'other.release',
						mediaTitle: 'Avatar',
						status: 'rejected',
						rejectedAt: now
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { search: 'Dune' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].mediaTitle).toBe('Dune');
		});

		it('filters by reason', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{
						id: randomUUID(),
						releaseTitle: 'A',
						primaryReason: 'quality_profile_mismatch',
						status: 'rejected',
						rejectedAt: now
					},
					{
						id: randomUUID(),
						releaseTitle: 'B',
						primaryReason: 'other',
						status: 'rejected',
						rejectedAt: now
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { reason: 'quality_profile_mismatch' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].primaryReason).toBe('quality_profile_mismatch');
		});

		it('filters by mediaType', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{
						id: randomUUID(),
						releaseTitle: 'A',
						mediaType: 'movie',
						status: 'rejected',
						rejectedAt: now
					},
					{
						id: randomUUID(),
						releaseTitle: 'B',
						mediaType: 'tv',
						status: 'rejected',
						rejectedAt: now
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { mediaType: 'movie' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].mediaType).toBe('movie');
		});

		it('filters by since=24h — excludes records older than 24h', async () => {
			const oldDate = new Date(Date.now() - 2 * 86_400_000).toISOString();
			const newDate = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{ id: randomUUID(), releaseTitle: 'Old', status: 'rejected', rejectedAt: oldDate },
					{ id: randomUUID(), releaseTitle: 'New', status: 'rejected', rejectedAt: newDate }
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { since: '24h' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].releaseTitle).toBe('New');
		});

		it('paginates results correctly', async () => {
			const now = new Date().toISOString();
			for (let i = 0; i < 5; i++) {
				testDb.db
					.insert(rejectedReleases)
					.values({
						id: randomUUID(),
						releaseTitle: `Movie ${i}`,
						status: 'rejected',
						rejectedAt: now
					})
					.run();
			}

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { page: '1', limit: '2' })
			);
			expect((data as any).data.records).toHaveLength(2);
			expect((data as any).data.pagination.total).toBe(5);
			expect((data as any).data.pagination.totalPages).toBe(3);
		});

		it('orders ascending when order=asc', async () => {
			const t1 = new Date(Date.now() - 10_000).toISOString();
			const t2 = new Date().toISOString();
			const id1 = randomUUID();
			const id2 = randomUUID();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{ id: id1, releaseTitle: 'Old', status: 'rejected', rejectedAt: t1 },
					{ id: id2, releaseTitle: 'New', status: 'rejected', rejectedAt: t2 }
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('rejected-releases', { order: 'asc' })
			);
			const records = (data as any).data.records;
			expect(records[0].id).toBe(id1);
			expect(records[1].id).toBe(id2);
		});

		it('orders descending by default', async () => {
			const t1 = new Date(Date.now() - 10_000).toISOString();
			const t2 = new Date().toISOString();
			const id1 = randomUUID();
			const id2 = randomUUID();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{ id: id1, releaseTitle: 'Old', status: 'rejected', rejectedAt: t1 },
					{ id: id2, releaseTitle: 'New', status: 'rejected', rejectedAt: t2 }
				])
				.run();

			const { data } = await callHandler(GET, 'GET', undefined, opts('rejected-releases'));
			const records = (data as any).data.records;
			expect(records[0].id).toBe(id2);
			expect(records[1].id).toBe(id1);
		});
	});

	// -------------------------------------------------------------------------
	// import-failures
	// -------------------------------------------------------------------------
	describe('GET import-failures', () => {
		it('excludes resolved records by default', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(importFailures)
				.values([
					{
						id: randomUUID(),
						releaseTitle: 'Active',
						failureStage: 'transfer',
						reason: 'transfer_failed',
						failedAt: now,
						status: 'failed'
					},
					{
						id: randomUUID(),
						releaseTitle: 'Done',
						failureStage: 'transfer',
						reason: 'transfer_failed',
						failedAt: now,
						status: 'resolved'
					}
				])
				.run();

			const { status, data } = await callHandler(GET, 'GET', undefined, opts('import-failures'));
			expect(status).toBe(200);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].status).toBe('failed');
		});

		it('includes downloadClientName from joined downloadClients', async () => {
			const clientId = randomUUID();
			testDb.db
				.insert(downloadClients)
				.values({
					id: clientId,
					name: 'qBittorrent Test',
					implementation: 'qbittorrent',
					host: 'localhost',
					port: 8080
				})
				.run();

			testDb.db
				.insert(importFailures)
				.values({
					id: randomUUID(),
					releaseTitle: 'Test Release',
					failureStage: 'transfer',
					reason: 'transfer_failed',
					downloadClientId: clientId,
					failedAt: new Date().toISOString(),
					status: 'failed'
				})
				.run();

			const { data } = await callHandler(GET, 'GET', undefined, opts('import-failures'));
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].downloadClientName).toBe('qBittorrent Test');
		});

		it('filters by stage', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(importFailures)
				.values([
					{
						id: randomUUID(),
						releaseTitle: 'A',
						failureStage: 'transfer',
						reason: 'transfer_failed',
						failedAt: now,
						status: 'failed'
					},
					{
						id: randomUUID(),
						releaseTitle: 'B',
						failureStage: 'path_resolution',
						reason: 'path_unavailable',
						failedAt: now,
						status: 'failed'
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('import-failures', { stage: 'transfer' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].failureStage).toBe('transfer');
		});
	});

	// -------------------------------------------------------------------------
	// renaming-failures
	// -------------------------------------------------------------------------
	describe('GET renaming-failures', () => {
		it('excludes resolved records by default', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(renamingFailures)
				.values([
					{
						id: randomUUID(),
						fileId: 'f1',
						fileType: 'movie',
						sourcePath: '/src/a',
						intendedPath: '/dst/a',
						reason: 'collision',
						failedAt: now,
						status: 'failed'
					},
					{
						id: randomUUID(),
						fileId: 'f2',
						fileType: 'movie',
						sourcePath: '/src/b',
						intendedPath: '/dst/b',
						reason: 'collision',
						failedAt: now,
						status: 'resolved'
					}
				])
				.run();

			const { data } = await callHandler(GET, 'GET', undefined, opts('renaming-failures'));
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].status).toBe('failed');
		});

		it('filters by reason', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(renamingFailures)
				.values([
					{
						id: randomUUID(),
						fileId: 'f1',
						fileType: 'movie',
						sourcePath: '/src/a',
						intendedPath: '/dst/a',
						reason: 'collision',
						failedAt: now,
						status: 'failed'
					},
					{
						id: randomUUID(),
						fileId: 'f2',
						fileType: 'movie',
						sourcePath: '/src/b',
						intendedPath: '/dst/b',
						reason: 'permission_denied',
						failedAt: now,
						status: 'failed'
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('renaming-failures', { reason: 'collision' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].reason).toBe('collision');
		});

		it('filters by fileType', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(renamingFailures)
				.values([
					{
						id: randomUUID(),
						fileId: 'f1',
						fileType: 'movie',
						sourcePath: '/src/a',
						intendedPath: '/dst/a',
						reason: 'collision',
						failedAt: now,
						status: 'failed'
					},
					{
						id: randomUUID(),
						fileId: 'f2',
						fileType: 'episode',
						sourcePath: '/src/b',
						intendedPath: '/dst/b',
						reason: 'collision',
						failedAt: now,
						status: 'failed'
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('renaming-failures', { fileType: 'episode' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].fileType).toBe('episode');
		});
	});

	// -------------------------------------------------------------------------
	// unmatched-imports
	// -------------------------------------------------------------------------
	describe('GET unmatched-imports', () => {
		it('reasonGroup=below_threshold includes low_confidence, multiple_matches, ambiguous', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(unmatchedFiles)
				.values([
					{
						id: randomUUID(),
						path: '/a.mkv',
						mediaType: 'movie',
						reason: 'low_confidence',
						discoveredAt: now
					},
					{
						id: randomUUID(),
						path: '/b.mkv',
						mediaType: 'movie',
						reason: 'multiple_matches',
						discoveredAt: now
					},
					{
						id: randomUUID(),
						path: '/c.mkv',
						mediaType: 'movie',
						reason: 'ambiguous',
						discoveredAt: now
					},
					{
						id: randomUUID(),
						path: '/d.mkv',
						mediaType: 'movie',
						reason: 'no_match',
						discoveredAt: now
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('unmatched-imports', { reasonGroup: 'below_threshold' })
			);
			const records = (data as any).data.records;
			expect(records).toHaveLength(3);
			const reasons = records.map((r: any) => r.reason);
			expect(reasons).toContain('low_confidence');
			expect(reasons).toContain('multiple_matches');
			expect(reasons).toContain('ambiguous');
			expect(reasons).not.toContain('no_match');
		});

		it('filters by mediaType', async () => {
			const now = new Date().toISOString();
			testDb.db
				.insert(unmatchedFiles)
				.values([
					{
						id: randomUUID(),
						path: '/movie.mkv',
						mediaType: 'movie',
						reason: 'no_match',
						discoveredAt: now
					},
					{
						id: randomUUID(),
						path: '/show.mkv',
						mediaType: 'tv',
						reason: 'no_match',
						discoveredAt: now
					}
				])
				.run();

			const { data } = await callHandler(
				GET,
				'GET',
				undefined,
				opts('unmatched-imports', { mediaType: 'tv' })
			);
			expect((data as any).data.records).toHaveLength(1);
			expect((data as any).data.records[0].mediaType).toBe('tv');
		});
	});

	// -------------------------------------------------------------------------
	// PATCH rejected-releases
	// -------------------------------------------------------------------------
	describe('PATCH rejected-releases bulk-resolve', () => {
		it('updates status for given ids only', async () => {
			const id1 = randomUUID();
			const id2 = randomUUID();
			const now = new Date().toISOString();
			testDb.db
				.insert(rejectedReleases)
				.values([
					{ id: id1, releaseTitle: 'A', status: 'rejected', rejectedAt: now },
					{ id: id2, releaseTitle: 'B', status: 'rejected', rejectedAt: now }
				])
				.run();

			const { status, data } = await callHandler(
				PATCH,
				'PATCH',
				{ ids: [id1], status: 'resolved' },
				opts('rejected-releases')
			);
			expect(status).toBe(200);
			expect((data as any).data.updated).toBe(1);

			const rows = testDb.db.select().from(rejectedReleases).all();
			expect(rows.find((r) => r.id === id1)!.status).toBe('resolved');
			expect(rows.find((r) => r.id === id2)!.status).toBe('rejected');
		});

		it('returns 400 when ids array is empty', async () => {
			const { status, data } = await callHandler(
				PATCH,
				'PATCH',
				{ ids: [], status: 'resolved' },
				opts('rejected-releases')
			);
			expect(status).toBe(400);
			expect((data as any).success).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// PATCH unmatched-imports
	// -------------------------------------------------------------------------
	describe('PATCH unmatched-imports', () => {
		it('returns 400 — managed via library page', async () => {
			const { status, data } = await callHandler(
				PATCH,
				'PATCH',
				{ ids: [randomUUID()], status: 'resolved' },
				opts('unmatched-imports')
			);
			expect(status).toBe(400);
			expect((data as any).success).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// PATCH import-failures
	// -------------------------------------------------------------------------
	describe('PATCH import-failures bulk-resolve', () => {
		it('sets resolvedAt when status is resolved', async () => {
			const id = randomUUID();
			testDb.db
				.insert(importFailures)
				.values({
					id,
					releaseTitle: 'Test',
					failureStage: 'transfer',
					reason: 'transfer_failed',
					failedAt: new Date().toISOString(),
					status: 'failed'
				})
				.run();

			const { status, data } = await callHandler(
				PATCH,
				'PATCH',
				{ ids: [id], status: 'resolved' },
				opts('import-failures')
			);
			expect(status).toBe(200);
			expect((data as any).data.updated).toBe(1);

			const row = testDb.db.select().from(importFailures).all()[0];
			expect(row.status).toBe('resolved');
			expect(row.resolvedAt).not.toBeNull();
		});
	});
});

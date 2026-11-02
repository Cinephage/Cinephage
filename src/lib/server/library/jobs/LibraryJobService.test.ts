import { describe, it, expect, afterAll, vi, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import { libraryJobs, rootFolders } from '#lib/server/db/schema.js';

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

const { libraryJobService } = await import('./LibraryJobService.js');

const rootIds = {
	'root-1': true,
	'root-2': true,
	'root-c1': true,
	'root-c2': true,
	'root-r1': true,
	'root-l1': true,
	'root-l2': true,
	'root-la1': true,
	'root-la2': true,
	'root-m1': true,
	'root-rt1': true,
	'root-rt2': true,
	'root-mf1': true,
	'root-mr1': true
};

beforeAll(() => {
	for (const id of Object.keys(rootIds)) {
		testDb.db
			.insert(rootFolders)
			.values({
				id,
				name: `Test Root ${id}`,
				path: `/test/${id}`,
				mediaType: 'movie'
			})
			.run();
	}
});

beforeEach(() => {
	testDb.db.delete(libraryJobs).run();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('LibraryJobService', () => {
	describe('enqueueRootFolderScan', () => {
		it('creates queued job with correct dedupe key', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-1');
			expect(job.type).toBe('scan_root_folder');
			expect(job.status).toBe('queued');
			expect(job.dedupeKey).toBe('scan_root_folder:root-1');
			expect(job.rootFolderId).toBe('root-1');
		});
	});

	describe('enqueueJob deduplication', () => {
		it('returns existing active job when dedupe key matches', async () => {
			const first = libraryJobService.enqueueRootFolderScan('root-2');
			const second = libraryJobService.enqueueRootFolderScan('root-2');
			expect(second.id).toBe(first.id);
			expect(second.status).toBe('queued');
		});
	});

	describe('cancelJob', () => {
		it('sets status to cancelled for a queued job', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-c1');
			const cancelled = libraryJobService.cancelJob(job.id);
			expect(cancelled.status).toBe('cancelled');
		});

		it('sets cancelRequested=true but stays running for a running job', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-c2');
			libraryJobService.markRunning(job.id);

			const result = libraryJobService.cancelJob(job.id);
			expect(result.status).toBe('running');
			expect(result.cancelRequested).toBe(true);
		});
	});

	describe('recoverInterruptedJobs', () => {
		it('marks running jobs as failed with interrupt message', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-r1');
			libraryJobService.markRunning(job.id);

			const count = libraryJobService.recoverInterruptedJobs();
			expect(count).toBe(1);

			const recovered = libraryJobService.getJob(job.id);
			expect(recovered?.status).toBe('failed');
			expect(recovered?.errorMessage).toContain('interrupted');
		});
	});

	describe('listRecentJobs', () => {
		it('returns jobs ordered by createdAt desc', async () => {
			const j1 = libraryJobService.enqueueRootFolderScan('root-l1');
			const j2 = libraryJobService.enqueueRootFolderScan('root-l2');

			const recent = libraryJobService.listRecentJobs(10);
			expect(recent.length).toBeGreaterThanOrEqual(2);

			const ids = recent.map((j) => j.id);
			expect(ids).toContain(j1.id);
			expect(ids).toContain(j2.id);

			for (let i = 1; i < recent.length; i++) {
				expect(recent[i - 1].createdAt! >= recent[i].createdAt!).toBe(true);
			}
		});
	});

	describe('listActiveJobs', () => {
		it('returns only queued and running jobs', async () => {
			const active = libraryJobService.enqueueRootFolderScan('root-la1');
			const cancelled = libraryJobService.enqueueRootFolderScan('root-la2');
			libraryJobService.cancelJob(cancelled.id);

			const list = libraryJobService.listActiveJobs();
			expect(list.some((j) => j.id === active.id)).toBe(true);
			expect(list.some((j) => j.id === cancelled.id)).toBe(false);
		});
	});

	describe('markCompleted', () => {
		it('sets status, phase, fields and completedAt', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-m1');
			libraryJobService.markRunning(job.id);

			const completed = libraryJobService.markCompleted(job.id, {
				phase: 'done',
				filesFound: 42,
				filesProcessed: 42,
				filesAdded: 5
			});

			expect(completed.status).toBe('completed');
			expect(completed.phase).toBe('done');
			expect(completed.filesFound).toBe(42);
			expect(completed.filesProcessed).toBe(42);
			expect(completed.filesAdded).toBe(5);
			expect(completed.completedAt).toBeTruthy();
		});
	});

	describe('retryJob', () => {
		it('creates a new queued job for a failed job', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-rt1');
			testDb.db
				.update(libraryJobs)
				.set({ status: 'failed', errorMessage: 'test error' })
				.where(eq(libraryJobs.id, job.id))
				.run();

			const retried = libraryJobService.retryJob(job.id);
			expect(retried.id).not.toBe(job.id);
			expect(retried.status).toBe('queued');
			expect(retried.dedupeKey).toBe(job.dedupeKey);
		});

		it('throws for non-failed and non-cancelled jobs', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-rt2');

			expect(() => libraryJobService.retryJob(job.id)).toThrow();
		});
	});

	describe('markFailed', () => {
		it('sets status to failed with error message', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-mf1');
			libraryJobService.markRunning(job.id);

			const failed = libraryJobService.markFailed(job.id, 'something went wrong');
			expect(failed.status).toBe('failed');
			expect(failed.errorMessage).toBe('something went wrong');
		});
	});

	describe('markRunning', () => {
		it('sets status to running and sets startedAt', async () => {
			const job = libraryJobService.enqueueRootFolderScan('root-mr1');
			const running = libraryJobService.markRunning(job.id);
			expect(running.status).toBe('running');
			expect(running.startedAt).toBeTruthy();
		});
	});

	describe('getJob', () => {
		it('returns undefined for nonexistent id', async () => {
			const result = libraryJobService.getJob('nonexistent');
			expect(result).toBeUndefined();
		});
	});

	describe('enqueueFullScan', () => {
		it('creates queued job with correct dedupe key', async () => {
			const job = libraryJobService.enqueueFullScan();
			expect(job.type).toBe('scan_all_root_folders');
			expect(job.status).toBe('queued');
			expect(job.dedupeKey).toBe('scan_all_root_folders');
		});
	});
});

describe('stale queued-job aging (issue #513)', () => {
	it('resets a stuck queued job older than 1h instead of blocking its dedupeKey forever', async () => {
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		testDb.db
			.insert(libraryJobs)
			.values({
				type: 'scan_all_root_folders',
				status: 'queued',
				dedupeKey: 'scan_all_root_folders',
				createdAt: old,
				updatedAt: old
			})
			.run();

		const job = libraryJobService.enqueueFullScan();

		expect(job.status).toBe('queued');
		const stale = testDb.db
			.select()
			.from(libraryJobs)
			.where(eq(libraryJobs.dedupeKey, 'scan_all_root_folders'))
			.all();
		const failed = stale.filter((j) => j.status === 'failed');
		expect(failed).toHaveLength(1);
		expect(failed[0].errorMessage).toContain('timed out');
	});

	it('does not age a fresh queued job', async () => {
		const fresh = libraryJobService.enqueueFullScan();
		const again = libraryJobService.enqueueFullScan();
		expect(again.id).toBe(fresh.id);
	});

	describe('claimNextJob', () => {
		it('returns null when there is nothing queued', () => {
			expect(libraryJobService.claimNextJob()).toBeNull();
		});

		it('claims the oldest queued job and marks it running', () => {
			const older = libraryJobService.enqueueRootFolderScan('root-1');
			testDb.db
				.update(libraryJobs)
				.set({ createdAt: '2020-01-01T00:00:00.000Z' })
				.where(eq(libraryJobs.id, older.id))
				.run();
			libraryJobService.enqueueRootFolderScan('root-2');

			const claimed = libraryJobService.claimNextJob();
			expect(claimed?.id).toBe(older.id);
			expect(claimed?.status).toBe('running');

			const reloaded = libraryJobService.getJob(older.id);
			expect(reloaded?.status).toBe('running');
			expect(reloaded?.startedAt).toBeTruthy();
		});

		it('never claims the same job twice', () => {
			libraryJobService.enqueueRootFolderScan('root-1');

			const first = libraryJobService.claimNextJob();
			const second = libraryJobService.claimNextJob();

			expect(first).not.toBeNull();
			expect(second).toBeNull();
		});

		it('only claims jobs matching the given types', () => {
			const scanJob = libraryJobService.enqueueRootFolderScan('root-1');
			const importJob = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:test',
				metadata: {}
			});

			const claimed = libraryJobService.claimNextJob(['manual_import']);
			expect(claimed?.id).toBe(importJob.id);

			// The scan job is untouched and still claimable by an unrestricted worker.
			expect(libraryJobService.getJob(scanJob.id)?.status).toBe('queued');
		});
	});

	describe('markCompleted metadata merge', () => {
		it('merges into existing metadata instead of replacing it', () => {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:merge-test',
				metadata: { request: { sourcePath: '/a' } }
			});

			libraryJobService.markCompleted(job.id, {
				filesAdded: 1,
				metadata: { result: { libraryId: 'lib-1' } }
			});

			const reloaded = libraryJobService.getJob(job.id);
			expect(reloaded?.metadata).toEqual({
				request: { sourcePath: '/a' },
				result: { libraryId: 'lib-1' }
			});
		});
	});

	describe('listJobs filters', () => {
		it('filters by type, status, and parentJobId', () => {
			const parentJobId = 'batch-1';
			libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:a'
			});
			const second = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:b'
			});
			libraryJobService.markCompleted(second.id);
			libraryJobService.enqueueRootFolderScan('root-1');

			const importJobs = libraryJobService.listJobs({ type: 'manual_import' });
			expect(importJobs).toHaveLength(2);

			const batch = libraryJobService.listJobs({ parentJobId });
			expect(batch).toHaveLength(2);

			const completedInBatch = libraryJobService.listJobs({
				parentJobId,
				status: 'completed'
			});
			expect(completedInBatch).toHaveLength(1);
			expect(completedInBatch[0].id).toBe(second.id);
		});
	});

	describe('hasActiveJobs', () => {
		it('returns false when nothing is queued or running', () => {
			expect(libraryJobService.hasActiveJobs()).toBe(false);
			expect(libraryJobService.hasActiveJobs('manual_import')).toBe(false);
		});

		it('returns true for a queued job of the given type, false for other types', () => {
			libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:has-active-test'
			});

			expect(libraryJobService.hasActiveJobs('manual_import')).toBe(true);
			expect(libraryJobService.hasActiveJobs('scan_root_folder')).toBe(false);
			expect(libraryJobService.hasActiveJobs()).toBe(true);
		});

		it('ignores completed jobs', () => {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:has-active-completed-test'
			});
			libraryJobService.markCompleted(job.id);

			expect(libraryJobService.hasActiveJobs('manual_import')).toBe(false);
		});
	});

	describe('summarizeManualImportBatches', () => {
		it('aggregates a multi-job batch with true totals, not a truncated page', () => {
			const parentJobId = 'summary-batch-1';
			for (let i = 0; i < 30; i++) {
				libraryJobService.enqueueJob({
					type: 'manual_import',
					parentJobId,
					dedupeKey: `manual_import:summary-${i}`,
					metadata: { groupName: `Item ${i}` }
				});
			}

			const batches = libraryJobService.summarizeManualImportBatches();
			const batch = batches.find((b) => b.key === parentJobId);
			expect(batch).toBeDefined();
			expect(batch!.total).toBe(30);
			expect(batch!.active).toBe(true);
			expect(batch!.completed).toBe(0);
			expect(batch!.failed).toBe(0);
		});

		it('reports a single standalone job keyed by its own id', () => {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:summary-single',
				metadata: { groupName: 'Solo Movie' }
			});

			const batches = libraryJobService.summarizeManualImportBatches();
			const batch = batches.find((b) => b.key === job.id);
			expect(batch).toBeDefined();
			expect(batch!.total).toBe(1);
			expect(batch!.itemName).toBe('Solo Movie');
		});

		it('marks a batch inactive once every job reaches a terminal status', () => {
			const parentJobId = 'summary-batch-2';
			const a = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:summary-a'
			});
			const b = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:summary-b'
			});
			libraryJobService.markCompleted(a.id);
			libraryJobService.markFailed(b.id, 'boom');

			const batch = libraryJobService
				.summarizeManualImportBatches()
				.find((batch) => batch.key === parentJobId);
			expect(batch?.active).toBe(false);
			expect(batch?.completed).toBe(1);
			expect(batch?.failed).toBe(1);
		});

		it('reports acknowledged=false until every job in the batch is dismissed', () => {
			const parentJobId = 'summary-batch-3';
			const a = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:summary-ack-a'
			});
			const b = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:summary-ack-b'
			});
			libraryJobService.markFailed(a.id, 'boom');
			libraryJobService.markFailed(b.id, 'boom');

			expect(
				libraryJobService.summarizeManualImportBatches().find((batch) => batch.key === parentJobId)
					?.acknowledged
			).toBe(false);

			libraryJobService.acknowledgeBatch(parentJobId);

			expect(
				libraryJobService.summarizeManualImportBatches().find((batch) => batch.key === parentJobId)
					?.acknowledged
			).toBe(true);
		});
	});

	describe('acknowledgeBatch', () => {
		it('acknowledges every job in a batch and reports the count', () => {
			const parentJobId = 'ack-batch-1';
			const a = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:ack-a'
			});
			const b = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:ack-b'
			});
			libraryJobService.markFailed(a.id, 'boom');
			libraryJobService.markFailed(b.id, 'boom');

			const result = libraryJobService.acknowledgeBatch(parentJobId);
			expect(result.acknowledged).toBe(2);

			const rows = libraryJobService.listBatchJobs(parentJobId);
			expect(rows.every((r) => r.acknowledgedAt !== null)).toBe(true);
		});

		it('acknowledges a standalone single-job batch by its own id', () => {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:ack-standalone'
			});
			libraryJobService.markFailed(job.id, 'boom');

			const result = libraryJobService.acknowledgeBatch(job.id);
			expect(result.acknowledged).toBe(1);
			expect(libraryJobService.getJob(job.id)?.acknowledgedAt).not.toBeNull();
		});

		it('is idempotent — re-acknowledging an already-dismissed batch changes nothing', () => {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:ack-idempotent'
			});
			libraryJobService.markFailed(job.id, 'boom');

			libraryJobService.acknowledgeBatch(job.id);
			const result = libraryJobService.acknowledgeBatch(job.id);
			expect(result.acknowledged).toBe(0);
		});
	});

	describe('cancelBatch', () => {
		it('cancels queued jobs immediately and leaves completed/failed ones alone', () => {
			const parentJobId = 'cancel-batch-1';
			const queued = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:cancel-queued'
			});
			const done = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:cancel-done'
			});
			libraryJobService.markCompleted(done.id);

			const result = libraryJobService.cancelBatch(parentJobId);
			expect(result.cancelled).toBe(1);
			expect(libraryJobService.getJob(queued.id)?.status).toBe('cancelled');
			expect(libraryJobService.getJob(done.id)?.status).toBe('completed');
		});

		it('flags a running job cooperatively instead of forcing it to stop', () => {
			const parentJobId = 'cancel-batch-2';
			const running = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:cancel-running'
			});
			libraryJobService.markRunning(running.id);

			const result = libraryJobService.cancelBatch(parentJobId);
			// A running job isn't counted as "cancelled" — it wasn't stopped,
			// only flagged for cooperative cancellation.
			expect(result.cancelled).toBe(0);
			const reloaded = libraryJobService.getJob(running.id);
			expect(reloaded?.status).toBe('running');
			expect(reloaded?.cancelRequested).toBe(true);
		});

		it('cancels a standalone single-job batch by its own id', () => {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:cancel-standalone'
			});

			const result = libraryJobService.cancelBatch(job.id);
			expect(result.cancelled).toBe(1);
			expect(libraryJobService.getJob(job.id)?.status).toBe('cancelled');
		});
	});

	describe('listBatchJobs / retryBatch', () => {
		it('finds every job in a multi-job batch by parentJobId', () => {
			const parentJobId = 'retry-batch-1';
			const a = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:retry-a'
			});
			const b = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:retry-b'
			});

			const rows = libraryJobService.listBatchJobs(parentJobId);
			expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
		});

		it('finds a standalone job by its own id as the batch key', () => {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: 'manual_import:retry-standalone'
			});

			const rows = libraryJobService.listBatchJobs(job.id);
			expect(rows).toHaveLength(1);
			expect(rows[0].id).toBe(job.id);
		});

		it('retries only the failed/cancelled jobs in a batch', () => {
			const parentJobId = 'retry-batch-2';
			const failed = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:retry-failed'
			});
			const succeeded = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: 'manual_import:retry-succeeded'
			});
			libraryJobService.markFailed(failed.id, 'boom');
			libraryJobService.markCompleted(succeeded.id);

			const result = libraryJobService.retryBatch(parentJobId);
			expect(result.retried).toBe(1);

			const rows = libraryJobService.listBatchJobs(parentJobId);
			// The original failed row stays as history; a fresh queued row joins it.
			expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
			expect(rows.filter((r) => r.status === 'failed')).toHaveLength(1);
			expect(rows.filter((r) => r.status === 'completed')).toHaveLength(1);
		});
	});
});

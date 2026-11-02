/**
 * Bulk Import API regression tests.
 *
 * Bug #496: importing a large number of files fails with a 400 "Invalid JSON body"
 * red box. Two compounding root causes:
 *   1. The backend rejected any batch > 500 jobs (zod .max(500)) while the UI sends
 *      one unbounded batch.
 *   2. adapter-node's default 512K BODY_SIZE_LIMIT aborts larger bodies before the
 *      handler runs, surfacing as "Invalid JSON body" (verified over live HTTP;
 *      the limit itself is raised in server.js / Dockerfile).
 *
 * This suite pins the batch-size cap (the part testable at handler level).
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';

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

// Stub out the library job service so this suite only exercises validation/
// batching, not real job persistence (that's LibraryJobService's own tests).
const enqueueJobMock = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/library/jobs/LibraryJobService.js', () => ({
	libraryJobService: {
		enqueueJob: enqueueJobMock
	}
}));

const { POST } = await import('./+server');

function buildJob(i: number) {
	return {
		request: {
			sourcePath: `/tmp/nonexistent-source-${i}.mkv`,
			mediaType: 'movie' as const,
			tmdbId: 1000 + i,
			importTarget: 'new' as const,
			importMode: 'symlink' as const,
			rootFolderId: '00000000-0000-4000-8000-000000000000'
		},
		groupName: `group_${i}`
	};
}

describe('Bulk Import API', () => {
	beforeEach(() => {
		enqueueJobMock.mockClear();
		let counter = 0;
		enqueueJobMock.mockImplementation(() => ({ id: `job-${++counter}` }));
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('accepts a batch of 500 jobs', async () => {
		const { status, data } = await api.post(POST, {
			jobs: Array.from({ length: 500 }, (_, i) => buildJob(i))
		});

		expect(status).toBe(200);
		expect(data).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					parentJobId: expect.any(String),
					totalGroups: 500,
					jobIds: expect.arrayContaining([expect.any(String)])
				})
			})
		);
		expect(enqueueJobMock).toHaveBeenCalledTimes(500);
	});

	it('accepts a batch of 501 jobs without a batch-size rejection (bug #496)', async () => {
		const { status, data } = await api.post(POST, {
			jobs: Array.from({ length: 501 }, (_, i) => buildJob(i))
		});

		expect(status).toBe(200);
		expect(JSON.stringify(data)).not.toContain('<=500 items');
		expect(data).not.toEqual(
			expect.objectContaining({
				error: 'Validation failed'
			})
		);
		expect(enqueueJobMock).toHaveBeenCalledTimes(501);
	});

	it('accepts a batch of 2600 jobs without a batch-size rejection (the reported scenario, bug #496)', async () => {
		const { status, data } = await api.post(POST, {
			jobs: Array.from({ length: 2600 }, (_, i) => buildJob(i))
		});

		expect(status).toBe(200);
		expect(JSON.stringify(data)).not.toContain('<=500 items');
		expect(data).not.toEqual(
			expect.objectContaining({
				error: 'Validation failed'
			})
		);
		expect(enqueueJobMock).toHaveBeenCalledTimes(2600);
		// Every job in the batch shares the same parentJobId for later grouping.
		const parentJobIds = new Set(
			enqueueJobMock.mock.calls.map(([input]) => input.parentJobId as string)
		);
		expect(parentJobIds.size).toBe(1);
	});

	it('rejects batches above the 5000-job hard cap', async () => {
		const { status, data } = await api.post(POST, {
			jobs: Array.from({ length: 5001 }, (_, i) => buildJob(i))
		});

		expect(status).toBe(400);
		expect(data).toEqual(
			expect.objectContaining({
				success: false,
				error: 'Validation failed'
			})
		);
		expect(enqueueJobMock).not.toHaveBeenCalled();
	});

	it('passes a per-import preferHardlink override through to the durable job (#584)', async () => {
		// The stored request is replayed by the import worker without
		// re-validation, so the override must survive the zod parse + enqueue
		// round-trip or it is stripped for good.
		const job = buildJob(0);
		const { status } = await api.post(POST, {
			jobs: [{ ...job, request: { ...job.request, preferHardlink: false } }]
		});

		expect(status).toBe(200);
		expect(enqueueJobMock).toHaveBeenCalledTimes(1);
		const enqueued = enqueueJobMock.mock.calls[0][0];
		expect(enqueued.metadata.request).toMatchObject({
			importMode: 'symlink',
			preferHardlink: false
		});
	});
});

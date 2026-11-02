import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../../../../test/db-helper';
import { callHandler } from '../../../../../../test/api-helper';
import { randomUUID } from 'node:crypto';
import { importFailures, downloadQueue, downloadClients } from '#lib/server/db/schema.js';

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

const mockRequestImport = vi.fn().mockResolvedValue({ status: 'queued' });

vi.mock('#lib/server/downloadClients/import/index.js', () => ({
	getImportService: vi.fn(() => ({ requestImport: mockRequestImport }))
}));

const { POST } = await import('./+server');

// Wrap callHandler to catch SvelteKit HttpErrors (thrown by error() helper)
async function call(id: string) {
	try {
		return await callHandler(POST, 'POST', undefined, {
			url: `http://localhost/api/reports/import-failures/${id}/retry`,
			params: { id },
			auth: 'admin' as const
		});
	} catch (err: any) {
		if (err && typeof err.status === 'number') {
			return {
				status: err.status,
				data: { success: false, message: err.body?.message ?? String(err.body) }
			};
		}
		throw err;
	}
}

describe('Import Failures Retry API', () => {
	let clientId: string;

	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(() => {
		clearTestDb(testDb);
		testDb.db.delete(importFailures).run();
		mockRequestImport.mockClear();
		mockRequestImport.mockResolvedValue({ status: 'queued' });

		// Seed a shared download client
		clientId = randomUUID();
		testDb.db
			.insert(downloadClients)
			.values({
				id: clientId,
				name: 'Test Client',
				implementation: 'qbittorrent',
				host: 'localhost',
				port: 8080
			})
			.run();
	});

	it('returns 404 when failure record not found', async () => {
		const { status } = await call(randomUUID());
		expect(status).toBe(404);
	});

	it('returns 400 when record is already resolved', async () => {
		const id = randomUUID();
		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'Test',
				failureStage: 'transfer',
				reason: 'transfer_failed',
				failedAt: new Date().toISOString(),
				status: 'resolved'
			})
			.run();

		const { status, data } = await call(id);
		expect(status).toBe(400);
		expect((data as any).success).toBe(false);
	});

	it('returns 404 when no matching queue entry found', async () => {
		const id = randomUUID();
		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'Some Release',
				sourcePath: '/nonexistent/path',
				failureStage: 'transfer',
				reason: 'transfer_failed',
				downloadClientId: clientId,
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();
		// No matching queue entry seeded

		const { status, data } = await call(id);
		expect(status).toBe(404);
		expect((data as any).success).toBe(false);
	});

	it('returns 422 when queue entry has no path', async () => {
		const id = randomUUID();
		const queueId = randomUUID();
		const sourcePath = '/mnt/downloads/release';

		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'No Path Release',
				sourcePath,
				failureStage: 'transfer',
				reason: 'transfer_failed',
				downloadClientId: clientId,
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		testDb.db
			.insert(downloadQueue)
			.values({
				id: queueId,
				downloadClientId: clientId,
				downloadId: 'abc123',
				title: 'No Path Release',
				status: 'completed',
				outputPath: sourcePath,
				clientDownloadPath: null
			})
			.run();

		// Remove both paths
		testDb.db.update(downloadQueue).set({ outputPath: null, clientDownloadPath: null }).run();

		const { status, data } = await call(id);
		expect(status).toBe(422);
		expect((data as any).success).toBe(false);
	});

	it('returns 400 when queue item status is not completed/postprocessing/failed', async () => {
		const id = randomUUID();
		const sourcePath = '/mnt/downloads/still-downloading';

		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'Downloading Release',
				sourcePath,
				failureStage: 'transfer',
				reason: 'transfer_failed',
				downloadClientId: clientId,
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		testDb.db
			.insert(downloadQueue)
			.values({
				id: randomUUID(),
				downloadClientId: clientId,
				downloadId: 'xyz789',
				title: 'Downloading Release',
				status: 'downloading',
				outputPath: sourcePath
			})
			.run();

		const { status, data } = await call(id);
		expect(status).toBe(400);
		expect((data as any).success).toBe(false);
	});

	it('happy path via sourcePath match: calls requestImport and returns success', async () => {
		const id = randomUUID();
		const queueId = randomUUID();
		const sourcePath = '/mnt/downloads/good-release';

		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'Good Release',
				sourcePath,
				failureStage: 'transfer',
				reason: 'transfer_failed',
				downloadClientId: clientId,
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		testDb.db
			.insert(downloadQueue)
			.values({
				id: queueId,
				downloadClientId: clientId,
				downloadId: 'hash001',
				title: 'Good Release',
				status: 'completed',
				outputPath: sourcePath
			})
			.run();

		const { status, data } = await call(id);
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);
		expect((data as any).importStatus).toBe('queued');
		expect(mockRequestImport).toHaveBeenCalledWith(queueId);

		// importFailure status should be 'retrying'
		const row = testDb.db.select().from(importFailures).all()[0];
		expect(row.status).toBe('retrying');
	});

	it('happy path via title fallback when sourcePath does not match', async () => {
		const id = randomUUID();
		const queueId = randomUUID();

		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'Title Match Release',
				sourcePath: null,
				failureStage: 'transfer',
				reason: 'transfer_failed',
				downloadClientId: clientId,
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		testDb.db
			.insert(downloadQueue)
			.values({
				id: queueId,
				downloadClientId: clientId,
				downloadId: 'hash002',
				title: 'Title Match Release',
				status: 'completed',
				outputPath: '/mnt/downloads/title-match'
			})
			.run();

		const { status, data } = await call(id);
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);
		expect(mockRequestImport).toHaveBeenCalledWith(queueId);
	});

	it('resets failed queue item to completed before calling requestImport', async () => {
		const id = randomUUID();
		const queueId = randomUUID();
		const sourcePath = '/mnt/downloads/failed-queue';

		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'Failed Queue Release',
				sourcePath,
				failureStage: 'transfer',
				reason: 'transfer_failed',
				downloadClientId: clientId,
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		testDb.db
			.insert(downloadQueue)
			.values({
				id: queueId,
				downloadClientId: clientId,
				downloadId: 'hash003',
				title: 'Failed Queue Release',
				status: 'failed',
				outputPath: sourcePath
			})
			.run();

		const { status, data } = await call(id);
		expect(status).toBe(200);
		expect((data as any).success).toBe(true);

		const qRow = testDb.db.select().from(downloadQueue).all()[0];
		expect(qRow.status).toBe('completed');
	});

	it('rolls back importFailure status to failed when requestImport throws', async () => {
		const id = randomUUID();
		const queueId = randomUUID();
		const sourcePath = '/mnt/downloads/error-release';

		testDb.db
			.insert(importFailures)
			.values({
				id,
				releaseTitle: 'Error Release',
				sourcePath,
				failureStage: 'transfer',
				reason: 'transfer_failed',
				downloadClientId: clientId,
				failedAt: new Date().toISOString(),
				status: 'failed'
			})
			.run();

		testDb.db
			.insert(downloadQueue)
			.values({
				id: queueId,
				downloadClientId: clientId,
				downloadId: 'hash004',
				title: 'Error Release',
				status: 'completed',
				outputPath: sourcePath
			})
			.run();

		mockRequestImport.mockRejectedValueOnce(new Error('import service down'));

		const { status, data } = await call(id);
		expect(status).toBe(500);
		expect((data as any).success).toBe(false);

		// Status rolled back to 'failed'
		const row = testDb.db.select().from(importFailures).all()[0];
		expect(row.status).toBe('failed');
	});
});

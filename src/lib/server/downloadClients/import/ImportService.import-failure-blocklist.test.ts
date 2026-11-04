/**
 * Terminal import failures must auto-blocklist automatic acquisitions: the
 * download was delivered but could never be imported, so without a blocklist
 * entry the missing-content search re-grabs the identical release forever
 * (each re-grab duplicate-links to the still-present client torrent).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, clearTestDb, type TestDatabase } from '../../../../test/db-helper';
import {
	blocklist,
	downloadClients,
	downloadQueue,
	movies,
	rootFolders
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

const markImporting = vi.fn();
vi.mock('../monitoring/DownloadMonitorService', () => ({
	downloadMonitor: {
		markImporting: (...args: unknown[]) => markImporting(...args),
		markImported: vi.fn(),
		markFailed: vi.fn()
	}
}));

vi.mock('../DownloadClientManager', () => ({
	getDownloadClientManager: () => ({
		getEnabledClients: async () => [],
		getClientInstance: async () => undefined
	})
}));

const extractMediaInfo = vi.fn();
vi.mock('#lib/server/library/media-info.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/library/media-info.js')>();
	return {
		...actual,
		mediaInfoService: { extractMediaInfo: (...args: unknown[]) => extractMediaInfo(...args) }
	};
});

const { ImportService } = await import('./ImportService');

const DOWNLOAD_CLIENT_ID = 'dc-import-failure';

function makeQueueItem(overrides: Partial<typeof downloadQueue.$inferInsert>) {
	return {
		id: randomUUID(),
		downloadClientId: DOWNLOAD_CLIENT_ID,
		downloadId: 'dl-1',
		title: 'Test.Movie.2026.1080p.WEB-DL-GROUP',
		protocol: 'torrent',
		status: 'completed',
		outputPath: '/downloads/Test.Movie.2026.1080p.WEB-DL-GROUP',
		...overrides
	} as typeof downloadQueue.$inferInsert;
}

async function seedMovie(movieId: string) {
	const rootFolderId = 'rf-import-failure';
	await testDb.db
		.insert(rootFolders)
		.values({
			id: rootFolderId,
			name: 'Movies',
			path: '/tmp/cinephage-import-failure-test',
			mediaType: 'movie'
		})
		.onConflictDoNothing();
	await testDb.db.insert(movies).values({
		id: movieId,
		tmdbId: 42,
		title: 'Test Movie',
		year: 2026,
		path: 'Test Movie (2026)',
		rootFolderId,
		hasFile: false
	});
}

async function runProcessImport(queueItemId: string) {
	const service = ImportService.getInstance();
	return (
		service as unknown as {
			_processImport: (
				queueItemId: string,
				correlationId: string
			) => Promise<{ success: boolean; error?: string }>;
		}
	)._processImport(queueItemId, 'test-correlation');
}

describe('ImportService terminal-import-failure blocklist', () => {
	beforeEach(async () => {
		clearTestDb(testDb);
		markImporting.mockReset().mockReturnValue('max_attempts');
		extractMediaInfo
			.mockReset()
			.mockResolvedValue({ videoCodec: 'hevc', width: 1920, height: 1080 });
		await testDb.db.insert(downloadClients).values({
			id: DOWNLOAD_CLIENT_ID,
			name: 'qbit',
			implementation: 'qbittorrent',
			enabled: true,
			host: 'localhost',
			port: 8080,
			useSsl: false
		});
		ImportService.resetInstance();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('blocklists an automatic release once import attempts are exhausted', async () => {
		const movieId = randomUUID();
		await seedMovie(movieId);
		const queueItem = makeQueueItem({
			movieId,
			isAutomatic: true,
			importAttempts: 10,
			errorMessage: 'No video files found in download',
			infoHash: 'terminal-failure-hash',
			size: 2048
		});
		await testDb.db.insert(downloadQueue).values(queueItem);

		const result = await runProcessImport(queueItem.id!);

		expect(result.success).toBe(false);
		expect(markImporting).toHaveBeenCalledWith(queueItem.id);

		const entries = await testDb.db.select().from(blocklist).where(eq(blocklist.movieId, movieId));
		expect(entries).toHaveLength(1);
		expect(entries[0].reason).toBe('import_failed');
		expect(entries[0].infoHash).toBe('terminal-failure-hash');
		expect(entries[0].message).toContain('11 attempts');
		expect(entries[0].message).toContain('No video files found in download');
		// Bounded TTL, not a permanent ban: import failures are often
		// environmental rather than release-specific.
		expect(entries[0].expiresAt).not.toBeNull();
	});

	it('does not blocklist a manual grab on the same terminal failure', async () => {
		const movieId = randomUUID();
		await seedMovie(movieId);
		const queueItem = makeQueueItem({
			movieId,
			isAutomatic: false,
			importAttempts: 10,
			errorMessage: 'No video files found in download'
		});
		await testDb.db.insert(downloadQueue).values(queueItem);

		const result = await runProcessImport(queueItem.id!);

		expect(result.success).toBe(false);
		const entries = await testDb.db.select().from(blocklist);
		expect(entries).toHaveLength(0);
	});

	it('does not blocklist when attempts have not been exhausted', async () => {
		markImporting.mockReset().mockReturnValue('success');
		const movieId = randomUUID();
		await seedMovie(movieId);
		const queueItem = makeQueueItem({
			movieId,
			isAutomatic: true,
			importAttempts: 3
		});
		await testDb.db.insert(downloadQueue).values(queueItem);

		// The import proceeds past markImporting and fails normally (the
		// outputPath does not exist on disk) - a non-terminal failure must
		// not produce a blocklist entry.
		const result = await runProcessImport(queueItem.id!);

		expect(result.success).toBe(false);
		const entries = await testDb.db.select().from(blocklist).where(eq(blocklist.movieId, movieId));
		expect(entries).toHaveLength(0);
	});
});

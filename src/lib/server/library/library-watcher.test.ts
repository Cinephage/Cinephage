import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';

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

vi.mock('@parcel/watcher', () => ({
	default: {
		subscribe: vi.fn().mockResolvedValue({
			unsubscribe: vi.fn().mockResolvedValue(undefined)
		})
	}
}));

vi.mock('./disk-scan.js', () => ({
	diskScanService: {
		get scanning() {
			return mockScanning;
		},
		scanRootFolder: vi.fn().mockResolvedValue({})
	}
}));

vi.mock('./media-matcher.js', () => ({
	mediaMatcherService: { processAllUnmatched: vi.fn().mockResolvedValue(undefined) }
}));

vi.mock('./media-info.js', () => ({
	isVideoFile: vi.fn(() => true)
}));

vi.mock('#lib/server/subtitles/services/subtitle-reconcile-hooks.js', () => ({
	scheduleReconcileRootFolder: vi.fn().mockResolvedValue(undefined)
}));

let mockScanning = false;

const { LibraryWatcherService, IGNORED_PATTERNS } = await import('./library-watcher.js');
const { diskScanService } = await import('./disk-scan.js');
const { libraryOperationLock } = await import('./library-operation-lock.js');
const { scheduleReconcileRootFolder } =
	await import('#lib/server/subtitles/services/subtitle-reconcile-hooks.js');

describe('LibraryWatcherService IGNORED_PATTERNS', () => {
	// @parcel/watcher's subscribe() throws synchronously if any ignore RegExp
	// carries flags ("RegExp ignore patterns must not have flags") - it has no
	// native concept of them. Chokidar's /i-flagged patterns don't survive the
	// swap as-is; this pins the invariant so a reintroduced flag fails loudly
	// here instead of silently breaking every watchFolder() call in prod.
	it('contains no flagged RegExp entries', () => {
		for (const pattern of IGNORED_PATTERNS) {
			expect(pattern).toBeInstanceOf(RegExp);
			expect(pattern.flags).toBe('');
		}
	});
});

describe('LibraryWatcherService.processPendingChanges', () => {
	// Access the singleton's internals for seeding/inspection (private fields).
	function watcherInternals() {
		const w = LibraryWatcherService.getInstance() as unknown as {
			pendingChanges: Map<
				string,
				{ type: string; path: string; rootFolderId: string; timestamp: number }
			>;
			processPendingChanges(): Promise<void>;
			processTimeout: NodeJS.Timeout | null;
		};
		return w;
	}

	beforeEach(() => {
		mockScanning = false;
		vi.clearAllMocks();
		watcherInternals().pendingChanges.clear();
		const w = watcherInternals();
		if (w.processTimeout) clearTimeout(w.processTimeout);
		w.processTimeout = null;
	});

	afterAll(() => {
		const w = watcherInternals();
		if (w.processTimeout) clearTimeout(w.processTimeout);
		w.processTimeout = null;
		destroyTestDb(testDb);
	});

	function seedChange(path: string) {
		watcherInternals().pendingChanges.set(path, {
			type: 'unlink',
			path,
			rootFolderId: 'folder-1',
			timestamp: Date.now()
		});
	}

	it('re-queues changes and does not scan while the operation lock is held', async () => {
		seedChange('/media/movie.mkv');
		await libraryOperationLock.withLock('rename', async () => {
			await watcherInternals().processPendingChanges();
		});

		expect(watcherInternals().pendingChanges.size).toBe(1);
		expect(diskScanService.scanRootFolder).not.toHaveBeenCalled();
	});

	it('re-queues changes while a scan is already running', async () => {
		mockScanning = true; // forces the pre-scan guard re-queue branch
		seedChange('/media/movie.mkv');
		await watcherInternals().processPendingChanges();

		expect(watcherInternals().pendingChanges.size).toBe(1);
	});

	it('drops changes when the scan fails permanently (no infinite re-queue loop)', async () => {
		seedChange('/media/movie.mkv');
		(diskScanService.scanRootFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('Root folder not found: folder-1')
		);
		// An EventEmitter 'error' emit with no listeners throws; attach a no-op.
		LibraryWatcherService.getInstance().on('error', () => {});
		// mockScanning stays false and no lock is held → catch runs, gating is false → drop.
		await watcherInternals().processPendingChanges();

		expect(diskScanService.scanRootFolder).toHaveBeenCalledTimes(1);
		expect(watcherInternals().pendingChanges.size).toBe(0);
	});

	it('scans the folder and schedules subtitle reconciliation on success', async () => {
		seedChange('/media/movie.mkv');
		await watcherInternals().processPendingChanges();

		expect(diskScanService.scanRootFolder).toHaveBeenCalledWith('folder-1');
		expect(scheduleReconcileRootFolder).toHaveBeenCalledWith('folder-1');
		expect(watcherInternals().pendingChanges.size).toBe(0);
	});
});

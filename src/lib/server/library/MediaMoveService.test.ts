import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.js';

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

const mockedMoveDirectoryWithinRoots = vi.fn();

vi.mock('#lib/server/filesystem/move-helpers.js', () => ({
	get moveDirectoryWithinRoots() {
		return mockedMoveDirectoryWithinRoots;
	}
}));

const notifierMocks = vi.hoisted(() => ({
	queueUpdate: vi.fn()
}));

vi.mock('#lib/server/notifications/mediabrowser/index.js', () => ({
	getMediaBrowserNotifier: () => ({ queueUpdate: notifierMocks.queueUpdate })
}));

vi.mock('./LibraryEntityService.js', () => ({
	getLibraryEntityService: () => ({
		resolveOwningLibraryForRootFolder: vi.fn().mockResolvedValue({ id: 'lib-1' })
	})
}));

const mockStartTask = vi.fn();
const mockCompleteTask = vi.fn();
const mockFailTask = vi.fn();

vi.mock('#lib/server/tasks/TaskHistoryService.js', () => ({
	getTaskHistoryService: () => ({
		startTask: mockStartTask,
		completeTask: mockCompleteTask,
		failTask: mockFailTask
	})
}));

const { mediaMoveService } = await import('./MediaMoveService.js');
const { libraryOperationLock } = await import('./library-operation-lock.js');
const { diskScanService } = await import('./disk-scan.js');

afterAll(() => {
	destroyTestDb(testDb);
});

beforeEach(() => {
	vi.clearAllMocks();
	mockStartTask.mockResolvedValue('history-id');
	mockCompleteTask.mockResolvedValue(undefined);
	mockFailTask.mockResolvedValue(undefined);
	mockedMoveDirectoryWithinRoots.mockResolvedValue({
		mode: 'move',
		sourcePath: '/src',
		destPath: '/dest'
	});
});

describe('MediaMoveService lock integration', () => {
	it('executeMoveTask holds the operation lock for the duration of the move', async () => {
		const withLockSpy = vi.spyOn(libraryOperationLock, 'withLock');
		const svc = mediaMoveService;

		// Missing root folders → the task fails gracefully inside, but the lock
		// must still have been acquired around the whole execution.
		// @ts-expect-error accessing private method for testing
		await svc.executeMoveTask('missing-task', 'missing-history', {
			mediaType: 'movie',
			mediaId: 'missing-movie',
			mediaTitle: 'Missing Movie',
			relativePath: 'Missing Movie (2020)',
			sourceRootFolderId: 'root-does-not-exist',
			destinationRootFolderId: 'root-also-does-not-exist'
		});

		expect(withLockSpy).toHaveBeenCalledWith('move', expect.any(Function));
		expect(libraryOperationLock.isLocked).toBe(false);
	});
});

describe('MediaMoveService move notifications', () => {
	beforeEach(() => {
		notifierMocks.queueUpdate.mockClear();
	});

	it('queues Deleted(source) and Modified(destination) after a successful root-folder move', async () => {
		const db = testDb.db;
		const sourceRootId = crypto.randomUUID();
		const destinationRootId = crypto.randomUUID();
		await db.insert(schema.rootFolders).values({
			id: sourceRootId,
			path: '/movies-root',
			mediaType: 'movie',
			name: 'movies-root'
		});
		await db.insert(schema.rootFolders).values({
			id: destinationRootId,
			path: '/other-root',
			mediaType: 'movie',
			name: 'other-root'
		});
		mockedMoveDirectoryWithinRoots.mockResolvedValue({
			mode: 'rename',
			sourcePath: '/movies-root/Movie (2020)',
			destPath: '/other-root/Movie (2020)'
		});

		const svc = mediaMoveService;
		// @ts-expect-error accessing private method for testing
		await svc.executeMoveTaskLocked('move-task', 'move-history', {
			mediaType: 'movie',
			mediaId: 'movie-1',
			mediaTitle: 'Movie',
			relativePath: 'Movie (2020)',
			sourceRootFolderId: sourceRootId,
			destinationRootFolderId: destinationRootId
		});

		expect(mockCompleteTask).toHaveBeenCalled();
		expect(notifierMocks.queueUpdate).toHaveBeenCalledWith(
			'/movies-root/Movie (2020)',
			'Deleted',
			'rename'
		);
		expect(notifierMocks.queueUpdate).toHaveBeenCalledWith(
			'/other-root/Movie (2020)',
			'Modified',
			'rename'
		);

		await db
			.delete(schema.rootFolders)
			.where(inArray(schema.rootFolders.id, [sourceRootId, destinationRootId]));
	});
});

describe('MediaMoveService scan-in-progress refusal', () => {
	it('records a failed task and never touches the filesystem while a library scan is in progress', async () => {
		const scanSpy = vi.spyOn(diskScanService, 'scanning', 'get').mockReturnValue(true);
		const svc = mediaMoveService;

		try {
			// @ts-expect-error accessing private method for testing
			await svc.executeMoveTask('move-task', 'move-history', {
				mediaType: 'movie',
				mediaId: 'movie-1',
				mediaTitle: 'Movie',
				relativePath: 'Movie (2020)',
				sourceRootFolderId: 'root-1',
				destinationRootFolderId: 'root-2'
			});
		} finally {
			scanSpy.mockRestore();
		}

		expect(mockedMoveDirectoryWithinRoots).not.toHaveBeenCalled();
		expect(mockFailTask).toHaveBeenCalledWith('move-history', [
			expect.stringMatching(/scan is in progress/i)
		]);
		expect(mockCompleteTask).not.toHaveBeenCalled();
	});
});

describe('MediaMoveService read-only destination refusal', () => {
	it('fails the task without moving files when the destination root is read-only', async () => {
		const sourceRootId = crypto.randomUUID();
		const destinationRootId = crypto.randomUUID();
		await testDb.db.insert(schema.rootFolders).values([
			{
				id: sourceRootId,
				path: '/movies-root',
				mediaType: 'movie',
				name: 'movies-root'
			},
			{
				id: destinationRootId,
				path: '/remote-root',
				mediaType: 'movie',
				name: 'remote-root',
				readOnly: true
			}
		]);

		try {
			// @ts-expect-error accessing private method for testing
			await mediaMoveService.executeMoveTaskLocked('move-task', 'move-history', {
				mediaType: 'movie',
				mediaId: 'movie-1',
				mediaTitle: 'Movie',
				relativePath: 'Movie (2020)',
				sourceRootFolderId: sourceRootId,
				destinationRootFolderId: destinationRootId
			});

			expect(mockedMoveDirectoryWithinRoots).not.toHaveBeenCalled();
			expect(mockFailTask).toHaveBeenCalledWith('move-history', [
				'Cannot move media to read-only root folder'
			]);
			expect(mockCompleteTask).not.toHaveBeenCalled();
		} finally {
			await testDb.db
				.delete(schema.rootFolders)
				.where(inArray(schema.rootFolders.id, [sourceRootId, destinationRootId]));
		}
	});
});

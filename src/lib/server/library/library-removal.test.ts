import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	removeEntityFromDisk,
	cancelQueuedDownloads,
	cancelEntityDownloads,
	releaseUnmatchedTracking
} from './library-removal.js';

const fs = vi.hoisted(() => ({
	namesRootItself: vi.fn(),
	deleteFilesWithinRoot: vi.fn(),
	deleteDirectoryWithinRoot: vi.fn()
}));
const clients = vi.hoisted(() => ({ getClientInstance: vi.fn() }));
const acquisition = vi.hoisted(() => ({
	cancelByQueueId: vi.fn(),
	releaseUnmatchedQueueItems: vi.fn()
}));
const dbDeleteWhere = vi.hoisted(() => vi.fn());
const dbSelectWhere = vi.hoisted(() => vi.fn());
const dbSelectFrom = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/filesystem/delete-helpers.js', () => fs);
vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => clients
}));
vi.mock('#lib/server/acquisition/AcquisitionService.js', () => ({
	acquisitionService: acquisition
}));
vi.mock('#lib/server/db/index.js', () => ({
	db: {
		delete: () => ({ where: dbDeleteWhere }),
		select: () => ({ from: dbSelectFrom })
	}
}));

beforeEach(() => {
	Object.values(fs).forEach((fn) => fn.mockReset());
	clients.getClientInstance.mockReset();
	acquisition.cancelByQueueId.mockReset();
	acquisition.releaseUnmatchedQueueItems.mockReset();
	dbDeleteWhere.mockReset();
	dbSelectWhere.mockReset();
	dbSelectFrom.mockReset();
	dbSelectFrom.mockReturnValue({ where: dbSelectWhere });
	dbSelectWhere.mockResolvedValue([]);
	fs.namesRootItself.mockReturnValue(false);
	fs.deleteDirectoryWithinRoot.mockResolvedValue('/movies/Alien (1979)');
	fs.deleteFilesWithinRoot.mockResolvedValue([]);
});

describe('removeEntityFromDisk', () => {
	it('deletes the entity folder when it is a folder of its own', async () => {
		const outcome = await removeEntityFromDisk({
			kind: 'movie',
			rootFolderPath: '/movies',
			entityPath: '/movies/Alien (1979)',
			relativePaths: ['Alien.1979.mkv']
		});

		expect(outcome).toBe('folder');
		expect(fs.deleteDirectoryWithinRoot).toHaveBeenCalledWith('/movies', '/movies/Alien (1979)');
		expect(fs.deleteFilesWithinRoot).not.toHaveBeenCalled();
	});

	it('removes only its own files when the entity is the root itself', async () => {
		fs.namesRootItself.mockReturnValue(true);
		fs.deleteFilesWithinRoot.mockResolvedValue(['/movies/Alien.1979.mkv']);

		const outcome = await removeEntityFromDisk({
			kind: 'series',
			rootFolderPath: '/movies',
			entityPath: '/movies',
			relativePaths: ['Alien.1979.mkv']
		});

		expect(outcome).toBe('files');
		expect(fs.deleteFilesWithinRoot).toHaveBeenCalledWith('/movies', ['/movies/Alien.1979.mkv']);
		expect(fs.deleteDirectoryWithinRoot).not.toHaveBeenCalled();
	});

	it('does nothing when the entity has no path', async () => {
		const outcome = await removeEntityFromDisk({
			kind: 'movie',
			rootFolderPath: '/movies',
			entityPath: null,
			relativePaths: []
		});

		expect(outcome).toBe('none');
		expect(fs.deleteDirectoryWithinRoot).not.toHaveBeenCalled();
		expect(fs.deleteFilesWithinRoot).not.toHaveBeenCalled();
	});

	it('does nothing when the entity has no root folder', async () => {
		const outcome = await removeEntityFromDisk({
			kind: 'series',
			rootFolderPath: null,
			entityPath: '/tv/Alien',
			relativePaths: []
		});

		expect(outcome).toBe('none');
		expect(fs.namesRootItself).not.toHaveBeenCalled();
	});
});

describe('cancelQueuedDownloads', () => {
	it('removes a torrent by its hash and releases the slot before dropping the row', async () => {
		const removeDownload = vi.fn().mockResolvedValue(undefined);
		clients.getClientInstance.mockResolvedValue({ removeDownload });

		await cancelQueuedDownloads([
			{
				id: 'q-1',
				downloadClientId: 'client-1',
				protocol: 'torrent',
				infoHash: 'hash-1',
				downloadId: 'download-1'
			}
		]);

		expect(removeDownload).toHaveBeenCalledWith('hash-1', true);
		expect(acquisition.cancelByQueueId).toHaveBeenCalledWith('q-1', 'media removed from library');
		expect(dbDeleteWhere).toHaveBeenCalledTimes(1);
	});

	it('removes a usenet download by its download id', async () => {
		const removeDownload = vi.fn().mockResolvedValue(undefined);
		clients.getClientInstance.mockResolvedValue({ removeDownload });

		await cancelQueuedDownloads([
			{
				id: 'q-2',
				downloadClientId: 'client-1',
				protocol: 'usenet',
				infoHash: null,
				downloadId: 'nzb-1'
			}
		]);

		expect(removeDownload).toHaveBeenCalledWith('nzb-1', true);
	});

	it('keeps going when the client refuses to remove the download', async () => {
		clients.getClientInstance.mockRejectedValue(new Error('client offline'));

		await cancelQueuedDownloads([
			{
				id: 'q-3',
				downloadClientId: 'client-1',
				protocol: 'torrent',
				infoHash: 'hash-3',
				downloadId: null
			}
		]);

		expect(acquisition.cancelByQueueId).toHaveBeenCalledWith('q-3', 'media removed from library');
		expect(dbDeleteWhere).toHaveBeenCalledTimes(1);
	});

	it('still cancels and drops rows that never reached a client', async () => {
		await cancelQueuedDownloads([
			{
				id: 'q-4',
				downloadClientId: null,
				protocol: null,
				infoHash: null,
				downloadId: null
			}
		]);

		expect(clients.getClientInstance).not.toHaveBeenCalled();
		expect(acquisition.cancelByQueueId).toHaveBeenCalledTimes(1);
		expect(dbDeleteWhere).toHaveBeenCalledTimes(1);
	});
});

describe('releaseUnmatchedTracking', () => {
	it('releases a movie through the movie column', () => {
		acquisition.releaseUnmatchedQueueItems.mockReturnValue({ released: 2, heldBack: 0 });

		const result = releaseUnmatchedTracking({ kind: 'movie', id: 'movie-1' });

		expect(acquisition.releaseUnmatchedQueueItems).toHaveBeenCalledWith(
			{ movieId: 'movie-1' },
			'files unmatched from library'
		);
		expect(result).toEqual({ released: 2, heldBack: 0 });
	});

	it('releases a series through the series column and carries the reason', () => {
		acquisition.releaseUnmatchedQueueItems.mockReturnValue({ released: 0, heldBack: 1 });

		const result = releaseUnmatchedTracking({ kind: 'series', id: 'series-1' }, 'batch removal');

		expect(acquisition.releaseUnmatchedQueueItems).toHaveBeenCalledWith(
			{ seriesId: 'series-1' },
			'batch removal'
		);
		expect(result).toEqual({ released: 0, heldBack: 1 });
	});
});

describe('cancelEntityDownloads', () => {
	it('stops every queue row for the entity and reports the count', async () => {
		dbSelectWhere.mockResolvedValue([
			{
				id: 'q-1',
				downloadClientId: 'client-1',
				protocol: 'torrent',
				infoHash: 'hash-1',
				downloadId: 'download-1'
			},
			{
				id: 'q-2',
				downloadClientId: null,
				protocol: null,
				infoHash: null,
				downloadId: null
			}
		]);
		clients.getClientInstance.mockResolvedValue(null);

		const count = await cancelEntityDownloads({ kind: 'movie', id: 'movie-1' });

		expect(count).toBe(2);
		expect(dbSelectFrom).toHaveBeenCalledTimes(1);
		expect(acquisition.cancelByQueueId).toHaveBeenCalledWith('q-1', 'media removed from library');
		expect(acquisition.cancelByQueueId).toHaveBeenCalledWith('q-2', 'media removed from library');
		expect(dbDeleteWhere).toHaveBeenCalledTimes(2);
	});

	it('does nothing when the entity has no queue rows', async () => {
		const count = await cancelEntityDownloads({ kind: 'series', id: 'series-1' });

		expect(count).toBe(0);
		expect(acquisition.cancelByQueueId).not.toHaveBeenCalled();
		expect(dbDeleteWhere).not.toHaveBeenCalled();
	});
});

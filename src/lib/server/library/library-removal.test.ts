import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeEntityFromDisk, cancelQueuedDownloads } from './library-removal.js';

const fs = vi.hoisted(() => ({
	namesRootItself: vi.fn(),
	deleteFilesWithinRoot: vi.fn(),
	deleteDirectoryWithinRoot: vi.fn()
}));
const clients = vi.hoisted(() => ({ getClientInstance: vi.fn() }));
const acquisition = vi.hoisted(() => ({ cancelByQueueId: vi.fn() }));
const dbDeleteWhere = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/filesystem/delete-helpers.js', () => fs);
vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => clients
}));
vi.mock('#lib/server/acquisition/AcquisitionService.js', () => ({
	acquisitionService: acquisition
}));
vi.mock('#lib/server/db/index.js', () => ({
	db: { delete: () => ({ where: dbDeleteWhere }) }
}));

beforeEach(() => {
	Object.values(fs).forEach((fn) => fn.mockReset());
	clients.getClientInstance.mockReset();
	acquisition.cancelByQueueId.mockReset();
	dbDeleteWhere.mockReset();
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

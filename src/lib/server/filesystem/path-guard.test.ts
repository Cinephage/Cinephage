import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetFolders = vi.fn<() => Promise<Array<{ id: string; path: string }>>>(async () => []);
const mockRealpath = vi.fn<(input: string) => Promise<string>>(async (input: string) => input);

vi.mock('#lib/server/downloadClients/RootFolderService.js', () => ({
	RootFolderService: class {
		getFolders = mockGetFolders;
	}
}));

vi.mock('node:fs/promises', () => ({
	realpath: mockRealpath
}));

describe('path-guard', () => {
	beforeEach(() => {
		mockGetFolders.mockClear();
		mockRealpath.mockReset();
		mockGetFolders.mockResolvedValue([]);
		mockRealpath.mockImplementation(async (input: string) => input);
		vi.resetModules();
	});

	it('allows a symlinked import path when its real path resolves into an allowed base path', async () => {
		mockRealpath.mockImplementation(async (input: string) => {
			if (input === '/downloads') {
				return '/media/Pool/Downloads';
			}
			return input;
		});

		const { isPathAllowed } = await import('./path-guard.js');
		await expect(isPathAllowed('/downloads')).resolves.toBe(true);
	});

	it('treats a symlinked path inside a managed root as managed', async () => {
		mockGetFolders.mockResolvedValue([
			{
				id: 'rf-1',
				path: '/media/Series'
			}
		]);
		mockRealpath.mockImplementation(async (input: string) => {
			if (input === '/series-link') {
				return '/media/Series';
			}
			if (input === '/series-link/Show/file.mkv') {
				return '/media/Series/Show/file.mkv';
			}
			return input;
		});

		const { isManagedRootPath, isPathInsideManagedRoot } = await import('./path-guard.js');
		await expect(isManagedRootPath('/series-link')).resolves.toBe(true);
		await expect(isPathInsideManagedRoot('/series-link/Show/file.mkv')).resolves.toBe(true);
	});

	it('resolves root folders once across multiple calls within the TTL (bug #495)', async () => {
		const { isPathAllowed, isManagedRootPath } = await import('./path-guard.js');

		await isPathAllowed('/downloads');
		await isPathAllowed('/downloads');
		await isManagedRootPath('/downloads');
		await isManagedRootPath('/downloads');

		expect(mockGetFolders).toHaveBeenCalledTimes(1);
	});

	it('re-resolves root folders after cache invalidation', async () => {
		const { isPathAllowed, invalidateRootFolderPathCache } = await import('./path-guard.js');

		await isPathAllowed('/downloads');
		invalidateRootFolderPathCache();
		await isPathAllowed('/downloads');

		expect(mockGetFolders).toHaveBeenCalledTimes(2);
	});

	it('allows a mount whose name is not a well-known base path (bug #676)', async () => {
		const { isPathAllowed } = await import('./path-guard.js');

		await expect(isPathAllowed('/mnt/media')).resolves.toBe(true);
		await expect(isPathAllowed('/media2')).resolves.toBe(true);
		await expect(isPathAllowed('/media2/Movies/Film (2024)')).resolves.toBe(true);
		await expect(isPathAllowed('/pool2/downloads')).resolves.toBe(true);
	});

	it('denies OS-critical trees and the app data directory', async () => {
		vi.stubEnv('DATA_DIR', '/srv/cinephage-data');

		const { isPathAllowed } = await import('./path-guard.js');

		await expect(isPathAllowed('/etc')).resolves.toBe(false);
		await expect(isPathAllowed('/etc/passwd')).resolves.toBe(false);
		await expect(isPathAllowed('/proc/self')).resolves.toBe(false);
		await expect(isPathAllowed('/usr/bin')).resolves.toBe(false);
		await expect(isPathAllowed('/dev/shm')).resolves.toBe(false);
		await expect(isPathAllowed('/root/.ssh')).resolves.toBe(false);
		await expect(isPathAllowed('/srv/cinephage-data/cinephage.db')).resolves.toBe(false);

		vi.unstubAllEnvs();
	});

	it('denies a symlink that resolves into a blocked tree', async () => {
		mockRealpath.mockImplementation(async (input: string) => {
			if (input === '/media2/etc-link') {
				return '/etc';
			}
			return input;
		});

		const { isPathAllowed } = await import('./path-guard.js');
		await expect(isPathAllowed('/media2/etc-link')).resolves.toBe(false);
	});

	it('keeps a configured root folder reachable when it lives inside a blocked tree', async () => {
		const { isPathAllowed } = await import('./path-guard.js');
		await expect(isPathAllowed('/root')).resolves.toBe(false);

		mockGetFolders.mockResolvedValue([{ id: 'rf-1', path: '/root/media' }]);
		vi.resetModules();

		const after = await import('./path-guard.js');
		await expect(after.isPathAllowed('/root/media/Movies')).resolves.toBe(true);
		await expect(after.isPathAllowed('/root')).resolves.toBe(true);
	});

	it('still allows the filesystem root listing (ancestor of the mount bases)', async () => {
		const { isPathAllowed } = await import('./path-guard.js');

		await expect(isPathAllowed('/')).resolves.toBe(true);
	});

	it('allows paths under a configured root folder outside the common bases', async () => {
		mockGetFolders.mockResolvedValue([{ id: 'rf-1', path: '/exotic-media' }]);

		const { isPathAllowed } = await import('./path-guard.js');
		await expect(isPathAllowed('/exotic-media/Movies')).resolves.toBe(true);
	});
});

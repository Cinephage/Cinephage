/**
 * MediaBrowserManager tests
 *
 * Focus: deleteMediaItemByTmdb behavior —
 * - retries once after a transient failure (live-observed Jellyfin HTTP 500
 *   when its own scanner raced the delete) before giving up,
 * - never throws (best-effort by design),
 * - respects the per-server event toggle when an eventKind is supplied
 *   (the folder-reorganize pre-delete is part of a RENAME flow → onRename).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	deleteItem: vi.fn<(itemId: string) => Promise<boolean>>()
}));

vi.mock('./MediaBrowserClient', () => {
	// Class mock: `new MediaBrowserClient(...)` must work, so the mock
	// implementation has to be constructable (an arrow function is not).
	class MockClient {
		deleteItem = mocks.deleteItem;
	}
	return { MediaBrowserClient: MockClient };
});

const dbState = vi.hoisted(() => ({
	enabledServers: [] as Array<Record<string, unknown>>,
	syncedRows: [] as Array<Record<string, unknown>>
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		select: vi.fn(() => {
			const chain = {
				from() {
					return this;
				},
				where() {
					return this;
				},
				orderBy: () => Promise.resolve(dbState.enabledServers),
				limit: () => Promise.resolve(dbState.syncedRows)
			};
			return chain;
		})
	}
}));

import { MediaBrowserManager } from './MediaBrowserManager';

function makeServer(overrides: Record<string, unknown> = {}) {
	return {
		id: 'server-1',
		name: 'Test Server',
		host: 'http://jellyfin.local',
		apiKey: 'key',
		serverType: 'jellyfin',
		enabled: true,
		pathMappings: null,
		onImport: true,
		onUpgrade: true,
		onRename: true,
		onDelete: true,
		...overrides
	};
}

beforeEach(() => {
	mocks.deleteItem.mockReset();
	dbState.enabledServers = [
		makeServer({ id: 'server-1' }),
		makeServer({ id: 'server-2', onRename: false })
	];
	dbState.syncedRows = [{ serverItemId: 'item-1' }];
});

describe('deleteMediaItemByTmdb', () => {
	it('retries once after a transient failure and succeeds', async () => {
		dbState.enabledServers = [makeServer({ id: 'server-1' })];
		mocks.deleteItem.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const manager = new MediaBrowserManager();

		const result = await manager.deleteMediaItemByTmdb(42, 'movie', {
			retryDelayMs: 1,
			eventKind: 'rename'
		});

		expect(result).toBe(1);
		expect(mocks.deleteItem).toHaveBeenCalledTimes(2);
	});

	it('returns 0 without throwing when both attempts fail', async () => {
		dbState.enabledServers = [makeServer({ id: 'server-1' })];
		mocks.deleteItem.mockResolvedValue(false);
		const manager = new MediaBrowserManager();

		await expect(
			manager.deleteMediaItemByTmdb(42, 'movie', { retryDelayMs: 1, eventKind: 'rename' })
		).resolves.toBe(0);
		expect(mocks.deleteItem).toHaveBeenCalledTimes(2);
	});

	it('skips servers with onRename=false when the pre-delete is gated on rename', async () => {
		mocks.deleteItem.mockResolvedValue(true);
		const manager = new MediaBrowserManager();

		const result = await manager.deleteMediaItemByTmdb(42, 'movie', {
			retryDelayMs: 1,
			eventKind: 'rename'
		});

		expect(result).toBe(1);
		expect(mocks.deleteItem).toHaveBeenCalledTimes(1);
	});

	it('skips servers with onDelete=false when gated on delete', async () => {
		mocks.deleteItem.mockResolvedValue(true);
		dbState.enabledServers = [makeServer({ id: 'server-1', onDelete: false })];
		const manager = new MediaBrowserManager();

		const result = await manager.deleteMediaItemByTmdb(42, 'movie', {
			retryDelayMs: 1,
			eventKind: 'delete'
		});

		expect(result).toBe(0);
		expect(mocks.deleteItem).not.toHaveBeenCalled();
	});

	it('skips Plex servers entirely — no per-item delete API', async () => {
		dbState.enabledServers = [makeServer({ id: 'plex-1', serverType: 'plex' })];
		mocks.deleteItem.mockResolvedValue(true);
		const manager = new MediaBrowserManager();

		const result = await manager.deleteMediaItemByTmdb(42, 'movie', { retryDelayMs: 1 });

		expect(result).toBe(0);
		expect(mocks.deleteItem).not.toHaveBeenCalled();
	});

	it('delivers to all enabled servers when no eventKind is supplied (legacy behavior)', async () => {
		mocks.deleteItem.mockResolvedValue(true);
		dbState.enabledServers = [
			makeServer({ id: 'server-1', onRename: false }),
			makeServer({ id: 'server-2', onDelete: false })
		];
		const manager = new MediaBrowserManager();

		const result = await manager.deleteMediaItemByTmdb(42, 'movie', { retryDelayMs: 1 });

		expect(result).toBe(2);
		expect(mocks.deleteItem).toHaveBeenCalledTimes(2);
	});
});

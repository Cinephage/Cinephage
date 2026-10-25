import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { api } from '../../../test/api-helper.js';
import { rootFolders } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

const mocks = vi.hoisted(() => ({
	createSmartList: vi.fn(),
	getSmartList: vi.fn(),
	updateSmartList: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/smartlists/index.js', () => ({
	getSmartListService: () => mocks
}));

const { POST } = await import('./+server.js');
const { PUT } = await import('./[id]/+server.js');

afterAll(() => {
	destroyTestDb(testDb);
});

async function insertRootFolder(readOnly: boolean): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(rootFolders).values({
		id,
		path: `/tmp/opencode/smartlist-${id}`,
		mediaType: 'movie',
		name: readOnly ? 'read-only-folder' : 'writable-folder',
		readOnly
	});
	return id;
}

describe('POST /api/smartlists read-only guard', () => {
	it('rejects a read-only root folder when Auto Search is enabled', async () => {
		const readOnlyFolderId = await insertRootFolder(true);

		const { status, data } = await api.post(POST, {
			name: 'My List',
			mediaType: 'movie',
			filters: {},
			autoAddBehavior: 'add_only',
			rootFolderId: readOnlyFolderId
		});

		expect(status).toBe(400);
		expect(data).toMatchObject({ error: expect.stringMatching(/read-only/i) });
		expect(mocks.createSmartList).not.toHaveBeenCalled();

		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, readOnlyFolderId));
	});

	it('accepts a writable root folder and creates the list', async () => {
		const writableFolderId = await insertRootFolder(false);
		mocks.createSmartList.mockResolvedValueOnce({ id: 'list-1', name: 'My List' });

		const { status } = await api.post(POST, {
			name: 'My List',
			mediaType: 'movie',
			filters: {},
			autoAddBehavior: 'add_only',
			rootFolderId: writableFolderId
		});

		expect(status).toBe(201);
		expect(mocks.createSmartList).toHaveBeenCalledWith(
			expect.objectContaining({ rootFolderId: writableFolderId })
		);

		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, writableFolderId));
	});
});

describe('PUT /api/smartlists/[id] read-only guard', () => {
	it('rejects pointing a list at a read-only root folder', async () => {
		const readOnlyFolderId = await insertRootFolder(true);
		mocks.getSmartList.mockResolvedValueOnce({
			id: 'list-1',
			mediaType: 'movie',
			autoAddBehavior: 'add_only',
			rootFolderId: null
		});

		const { status, data } = await api.put(
			PUT,
			{ rootFolderId: readOnlyFolderId },
			{ params: { id: 'list-1' } }
		);

		expect(status).toBe(400);
		expect(data).toMatchObject({ error: expect.stringMatching(/read-only/i) });
		expect(mocks.updateSmartList).not.toHaveBeenCalled();

		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, readOnlyFolderId));
	});

	it('accepts a writable root folder and updates the list', async () => {
		const writableFolderId = await insertRootFolder(false);
		mocks.getSmartList.mockResolvedValueOnce({
			id: 'list-1',
			mediaType: 'movie',
			autoAddBehavior: 'add_only',
			rootFolderId: null
		});
		mocks.updateSmartList.mockResolvedValueOnce({
			id: 'list-1',
			mediaType: 'movie',
			rootFolderId: writableFolderId
		});

		const { status } = await api.put(
			PUT,
			{ rootFolderId: writableFolderId },
			{ params: { id: 'list-1' } }
		);

		expect(status).toBe(200);
		expect(mocks.updateSmartList).toHaveBeenCalledWith(
			'list-1',
			expect.objectContaining({ rootFolderId: writableFolderId })
		);

		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, writableFolderId));
	});
});

import { afterAll, describe, expect, it, vi } from 'vitest';
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

const { rootFolders } = await import('#lib/server/db/schema.js');
const { eq, and } = await import('drizzle-orm');
const { RootFolderService } = await import('./RootFolderService.js');

afterAll(() => {
	destroyTestDb(testDb);
});

async function seedFolder(name: string, path: string, isDefault: boolean) {
	const rows = await testDb.db
		.insert(rootFolders)
		.values({ name, path, mediaType: 'movie', mediaSubType: 'standard', isDefault })
		.returning({ id: rootFolders.id })
		.all();
	return rows[0]!.id;
}

async function isDefaultNow(id: string): Promise<boolean> {
	const row = await testDb.db
		.select({ isDefault: rootFolders.isDefault })
		.from(rootFolders)
		.where(eq(rootFolders.id, id))
		.get();
	return Boolean(row?.isDefault);
}

async function cleanup(ids: string[]) {
	for (const id of ids) {
		await testDb.db.delete(rootFolders).where(eq(rootFolders.id, id));
	}
}

describe('RootFolderService default auto-promotion', () => {
	it('promotes another root folder when the default is deleted', async () => {
		const defaultId = await seedFolder('Default', '/tmp/test-rf-delete-default', true);
		const otherId = await seedFolder('Other', '/tmp/test-rf-delete-other', false);

		const service = new RootFolderService();
		await service.deleteFolder(defaultId);

		expect(await isDefaultNow(otherId)).toBe(true);

		await cleanup([otherId]);
	});

	it('rejects unsetting the default directly when another folder exists', async () => {
		const defaultId = await seedFolder('Default', '/tmp/test-rf-unset-default', true);
		const otherId = await seedFolder('Other', '/tmp/test-rf-unset-other', false);

		const service = new RootFolderService();
		await expect(service.updateFolder(defaultId, { isDefault: false })).rejects.toThrow(
			/set a different one as default/
		);

		// Nothing changed - still the default, exactly as before the rejected call.
		expect(await isDefaultNow(defaultId)).toBe(true);
		expect(await isDefaultNow(otherId)).toBe(false);

		await cleanup([defaultId, otherId]);
	});

	it('rejects unsetting the default when it is the only folder for that media type/subtype', async () => {
		const onlyId = await seedFolder('Only', '/tmp/test-rf-unset-only', true);

		const service = new RootFolderService();
		await expect(service.updateFolder(onlyId, { isDefault: false })).rejects.toThrow(
			/only root folder/
		);
		expect(await isDefaultNow(onlyId)).toBe(true);

		await cleanup([onlyId]);
	});

	it('changes the default by setting a different folder as default, not by unsetting', async () => {
		const defaultId = await seedFolder('Default', '/tmp/test-rf-switch-default', true);
		const otherId = await seedFolder('Other', '/tmp/test-rf-switch-other', false);

		const service = new RootFolderService();
		await service.updateFolder(otherId, { isDefault: true });

		expect(await isDefaultNow(defaultId)).toBe(false);
		expect(await isDefaultNow(otherId)).toBe(true);

		await cleanup([defaultId, otherId]);
	});

	it('does nothing when a default already exists for that media type/subtype', async () => {
		const defaultId = await seedFolder('Default', '/tmp/test-rf-keep-default', true);
		const otherId = await seedFolder('Other', '/tmp/test-rf-keep-other', false);

		const service = new RootFolderService();
		// Update something unrelated (name) - the existing default must stay
		// the default, not get reshuffled by the promotion check running on
		// every update.
		await service.updateFolder(otherId, { name: 'Renamed Other' });

		expect(await isDefaultNow(defaultId)).toBe(true);
		expect(await isDefaultNow(otherId)).toBe(false);

		await cleanup([defaultId, otherId]);
	});

	it('leaves the media type/subtype defaultless when no other folder exists', async () => {
		const defaultId = await seedFolder('Only', '/tmp/test-rf-only', true);

		const service = new RootFolderService();
		await service.deleteFolder(defaultId);

		const remaining = await testDb.db
			.select()
			.from(rootFolders)
			.where(and(eq(rootFolders.mediaType, 'movie'), eq(rootFolders.mediaSubType, 'standard')))
			.all();
		expect(remaining).toHaveLength(0);
	});

	it('promoteAllMissingDefaults heals legacy data with no migration needed', async () => {
		// Simulates data from before this auto-promotion existed: a group
		// with folders but none flagged default. Uses 'tv' to stay isolated
		// from the 'movie'/'standard' group other tests in this file touch.
		const older = await testDb.db
			.insert(rootFolders)
			.values({
				name: 'Older',
				path: '/tmp/test-rf-legacy-older',
				mediaType: 'tv',
				mediaSubType: 'standard',
				isDefault: false,
				createdAt: '2020-01-01T00:00:00.000Z'
			})
			.returning({ id: rootFolders.id })
			.all();
		const newer = await testDb.db
			.insert(rootFolders)
			.values({
				name: 'Newer',
				path: '/tmp/test-rf-legacy-newer',
				mediaType: 'tv',
				mediaSubType: 'standard',
				isDefault: false,
				createdAt: '2020-01-02T00:00:00.000Z'
			})
			.returning({ id: rootFolders.id })
			.all();
		const olderId = older[0]!.id;
		const newerId = newer[0]!.id;

		const service = new RootFolderService();
		await service.promoteAllMissingDefaults();

		expect(await isDefaultNow(olderId)).toBe(true);
		expect(await isDefaultNow(newerId)).toBe(false);

		await cleanup([olderId, newerId]);
	});
});

import { describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';

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

const { getOrAssignArrId, getOrAssignArrIds, getEntityIdForArrId } =
	await import('./ArrIdMappingService.js');

describe('ArrIdMappingService', () => {
	it('assigns a new surrogate ID on first use and reuses it on later calls', async () => {
		const first = await getOrAssignArrId('rootFolder', 'uuid-a');
		const second = await getOrAssignArrId('rootFolder', 'uuid-a');
		expect(first).toBe(second);
		expect(Number.isInteger(first)).toBe(true);
	});

	it('keeps entity types independent - the same UUID in two types gets two IDs', async () => {
		const asRootFolder = await getOrAssignArrId('rootFolder', 'uuid-shared');
		const asQualityProfile = await getOrAssignArrId('qualityProfile', 'uuid-shared');
		expect(asRootFolder).not.toBe(asQualityProfile);
	});

	it('batches a list, assigning new IDs only for entities not already mapped', async () => {
		const pre = await getOrAssignArrId('tag', 'uuid-b');
		const batch = await getOrAssignArrIds('tag', ['uuid-b', 'uuid-c', 'uuid-b']);
		expect(batch.get('uuid-b')).toBe(pre);
		expect(batch.get('uuid-c')).toBeTypeOf('number');
		expect(batch.get('uuid-c')).not.toBe(pre);
		expect(batch.size).toBe(2);
	});

	it('returns an empty map for an empty batch without querying', async () => {
		const batch = await getOrAssignArrIds('movie', []);
		expect(batch.size).toBe(0);
	});

	it('resolves a surrogate ID back to its Cinephage UUID', async () => {
		const id = await getOrAssignArrId('series', 'uuid-d');
		expect(await getEntityIdForArrId('series', id)).toBe('uuid-d');
	});

	it('returns undefined for an ID that was never assigned', async () => {
		expect(await getEntityIdForArrId('series', 999999)).toBeUndefined();
	});
});

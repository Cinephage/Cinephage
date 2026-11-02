import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db-helper';
import { downloadClients } from '#lib/server/db/schema.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

afterEach(() => {
	testDb.db.delete(downloadClients).run();
	vi.restoreAllMocks();
});

const connection = {
	host: 'localhost',
	port: 8080
};

describe('qBittorrent sequential download configuration', () => {
	it('accepts the setting only for qBittorrent', async () => {
		const { downloadClientCreateSchema, downloadClientUpdateSchemaForImplementation } =
			await import('#lib/validation/schemas.js');

		expect(
			downloadClientCreateSchema.parse({
				name: 'qBit',
				implementation: 'qbittorrent',
				...connection,
				sequentialDownload: true
			})
		).toMatchObject({ sequentialDownload: true });
		expect(() =>
			downloadClientCreateSchema.parse({
				name: 'Transmission',
				implementation: 'transmission',
				...connection,
				sequentialDownload: true
			})
		).toThrow(/qBittorrent/i);
		expect(
			downloadClientUpdateSchemaForImplementation('qbittorrent').parse({
				sequentialDownload: false
			})
		).toEqual({ sequentialDownload: false });
		expect(() =>
			downloadClientUpdateSchemaForImplementation('transmission').parse({
				sequentialDownload: false
			})
		).toThrow(/qBittorrent/i);
	});

	it('persists the setting for qBittorrent and defaults it off elsewhere', async () => {
		const { DownloadClientManager } = await import('./DownloadClientManager');
		const manager = new DownloadClientManager();
		const qbit = await manager.createClient({
			name: 'qBit',
			implementation: 'qbittorrent',
			...connection,
			sequentialDownload: true
		});
		const transmission = await manager.createClient({
			name: 'Transmission',
			implementation: 'transmission',
			...connection,
			sequentialDownload: true
		});

		expect(qbit.sequentialDownload).toBe(true);
		expect(transmission.sequentialDownload).toBe(false);
		expect(
			(await manager.updateClient(qbit.id, { sequentialDownload: false })).sequentialDownload
		).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db-helper';
import { downloadClients } from '#lib/server/db/schema.js';

const testDb = createTestDb();
const defaultSecret = process.env.BETTER_AUTH_SECRET ?? 'test-secret';

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
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

beforeEach(() => {
	process.env.BETTER_AUTH_SECRET = defaultSecret;
});

afterEach(() => {
	testDb.db.delete(downloadClients).run();
	process.env.BETTER_AUTH_SECRET = defaultSecret;
	vi.restoreAllMocks();
});

function rawClient(id: string): Record<string, unknown> {
	return testDb.sqlite.prepare('SELECT * FROM download_clients WHERE id = ?').get(id) as Record<
		string,
		unknown
	>;
}

describe('debrid client configuration', () => {
	it('registers both providers under the debrid protocol', async () => {
		const { clientDefinitions } =
			await import('#lib/components/downloadClients/forms/clientDefinitions.js');
		const { DownloadClientManager } = await import('./DownloadClientManager');

		expect(clientDefinitions.map(({ id }) => id)).toEqual(
			expect.arrayContaining(['realdebrid', 'torbox'])
		);
		expect(DownloadClientManager.getProtocolForImplementation('realdebrid')).toBe('debrid');
		expect(DownloadClientManager.getProtocolForImplementation('torbox')).toBe('debrid');
		expect(DownloadClientManager.getProtocolForImplementation('qbittorrent')).toBe('torrent');
	});

	it('encrypts tokens with a dedicated key and fails closed after an auth-secret change', async () => {
		const { encryptDebridToken, decryptDebridToken } =
			await import('#lib/server/crypto/debridTokenCrypto.js');
		const { encryptApiKey } = await import('#lib/server/crypto/apiKeyCrypto.js');
		const encrypted = encryptDebridToken('secret-token');

		expect(encrypted).not.toBe('secret-token');
		expect(decryptDebridToken(encrypted)).toBe('secret-token');
		expect(encrypted.split(':')[2]).not.toBe(encryptApiKey('secret-token').split(':')[2]);

		process.env.BETTER_AUTH_SECRET = 'different-secret';
		expect(decryptDebridToken(encrypted)).toBeNull();
	});

	it('stores encrypted credentials while every public client shape remains redacted', async () => {
		const { DownloadClientManager } = await import('./DownloadClientManager');
		const { decryptCredential } = await import('#lib/server/crypto/credentialsCrypto.js');
		const manager = new DownloadClientManager();
		const created = await manager.createClient({
			name: 'Real-Debrid',
			implementation: 'realdebrid',
			apiToken: 'original-token',
			removeAfterImport: true,
			priority: 2
		});
		const originalCiphertext = rawClient(created.id).api_token as string;

		expect(created).toMatchObject({
			implementation: 'realdebrid',
			hasApiToken: true,
			removeAfterImport: true,
			host: 'api.real-debrid.com',
			port: 443
		});
		expect(JSON.stringify(created)).not.toContain('original-token');
		// Stored under the versioned envelope bound to the client id.
		expect(decryptCredential('debrid-token', created.id, originalCiphertext)).toBe(
			'original-token'
		);

		await manager.updateClient(created.id, { name: 'Renamed' });
		expect(rawClient(created.id).api_token).toBe(originalCiphertext);
		await manager.updateClient(created.id, { apiToken: 'replacement-token' });
		expect(
			decryptCredential('debrid-token', created.id, rawClient(created.id).api_token as string)
		).toBe('replacement-token');

		const serialized = JSON.stringify(await manager.getClients());
		expect(serialized).not.toContain('replacement-token');
		expect(serialized).not.toContain('api_token');
	});

	it('accepts only the debrid transport fields without weakening legacy validation', async () => {
		const { downloadClientCreateSchema, downloadClientTestSchema } =
			await import('#lib/validation/schemas.js');
		const debrid = {
			name: 'TorBox',
			implementation: 'torbox' as const,
			apiToken: 'token',
			removeAfterImport: true
		};

		expect(downloadClientCreateSchema.parse(debrid)).toMatchObject(debrid);
		for (const field of [
			'host',
			'port',
			'username',
			'password',
			'downloadPathLocal',
			'movieCategory',
			'seedRatioLimit',
			'sequentialDownload',
			'initialState'
		]) {
			expect(() => downloadClientCreateSchema.parse({ ...debrid, [field]: 'forbidden' })).toThrow();
		}
		expect(() =>
			downloadClientCreateSchema.parse({ name: 'qBit', implementation: 'qbittorrent' })
		).toThrow();
		expect(
			downloadClientCreateSchema.parse({
				name: 'qBit',
				implementation: 'qbittorrent',
				host: '127.0.0.1',
				port: 8080
			}).implementation
		).toBe('qbittorrent');
		expect(
			downloadClientTestSchema.parse({ implementation: 'torbox', apiToken: 'token' })
		).toBeDefined();
	});

	it('loads credentials only at the server test boundary and never leaks failures', async () => {
		const { DownloadClientManager } = await import('./DownloadClientManager');
		const manager = new DownloadClientManager();
		const created = await manager.createClient({
			name: 'TorBox',
			implementation: 'torbox',
			apiToken: 'stored-token'
		});
		const testClient = vi.spyOn(manager, 'testClient').mockResolvedValue({ success: true });

		expect(
			await manager.testClientWithCredentialFallback(created.id, { implementation: 'torbox' })
		).toEqual({ success: true });
		expect(testClient).toHaveBeenLastCalledWith(
			expect.objectContaining({ apiToken: 'stored-token' })
		);

		await manager.testClientWithCredentialFallback(created.id, {
			implementation: 'torbox',
			apiToken: 'explicit-token'
		});
		expect(testClient).toHaveBeenLastCalledWith(
			expect.objectContaining({ apiToken: 'explicit-token' })
		);

		testClient.mockClear();
		testDb.sqlite
			.prepare('UPDATE download_clients SET api_token = ? WHERE id = ?')
			.run('corrupt', created.id);
		const failure = await manager.testClientWithCredentialFallback(created.id, {
			implementation: 'torbox'
		});
		expect(failure.success).toBe(false);
		expect(testClient).not.toHaveBeenCalled();
		expect(JSON.stringify(failure)).not.toContain('stored-token');
	});

	it('keeps debrid adapters out of the generic enabled-client instance path', async () => {
		const { DownloadClientManager } = await import('./DownloadClientManager');
		const manager = new DownloadClientManager();
		await manager.createClient({
			name: 'TorBox',
			implementation: 'torbox',
			apiToken: 'token'
		});
		const getClientInstance = vi.spyOn(manager, 'getClientInstance');

		expect(await manager.getEnabledClients()).toEqual([]);
		expect(getClientInstance).not.toHaveBeenCalled();
	});

	it('uses the stored implementation to reject unsafe partial updates', async () => {
		const { DownloadClientManager } = await import('./DownloadClientManager');
		const { PUT } = await import('../../../routes/api/download-clients/[id]/+server');
		const { api } = await import('../../../test/api-helper');
		const manager = new DownloadClientManager();
		const client = await manager.createClient({
			name: 'Real-Debrid',
			implementation: 'realdebrid',
			apiToken: 'token'
		});

		for (const payload of [
			{ host: 'attacker.example' },
			{ seedRatioLimit: '2' },
			{ implementation: 'qbittorrent', host: 'localhost', port: 8080 }
		]) {
			const response = await api.put<{ success: boolean }>(PUT, payload, {
				params: { id: client.id }
			});
			expect(response.status).toBe(400);
			expect(response.data.success).toBe(false);
		}
		expect((await manager.getClient(client.id))?.implementation).toBe('realdebrid');
	});
});

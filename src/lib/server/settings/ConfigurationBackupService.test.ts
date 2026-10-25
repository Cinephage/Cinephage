import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db-helper';
import { downloadClients, namingPresets } from '#lib/server/db/schema.js';

const testDb = createTestDb();
const DEFAULT_SECRET = process.env.BETTER_AUTH_SECRET ?? 'test-secret';

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

describe('ConfigurationBackupService debrid safety', () => {
	afterEach(() => {
		testDb.db.delete(downloadClients).run();
		process.env.BETTER_AUTH_SECRET = DEFAULT_SECRET;
	});

	it('restores plaintext tokens without guessing their format', async () => {
		const { getConfigurationBackupService } = await import('./ConfigurationBackupService');
		const { encryptBackupPayload } = await import('#lib/server/crypto/backupCrypto.js');
		const clientId = 'debrid-client-1';
		const token = 'looks:like:encrypted:but:is:plaintext';
		const backup = {
			format: 'cinephage-config-backup' as const,
			version: 1 as const,
			createdAt: new Date().toISOString(),
			manifest: undefined,
			options: {},
			data: {
				downloadClients: [
					{
						id: clientId,
						name: 'Real-Debrid',
						implementation: 'realdebrid',
						enabled: true,
						host: 'api.real-debrid.com',
						port: 443,
						apiToken: null,
						removeAfterImport: true,
						priority: 1
					}
				]
			},
			secrets: encryptBackupPayload(
				{ tables: { downloadClients: { [clientId]: { apiToken: token } } } },
				'passphrase-12345'
			)
		};

		process.env.BETTER_AUTH_SECRET = 'restore-no-regex-secret';
		await getConfigurationBackupService().restoreConfig(backup, {
			passphrase: 'passphrase-12345',
			sections: ['downloads']
		});
		const row = testDb.sqlite
			.prepare(`SELECT "api_token" FROM "download_clients" WHERE "id" = ?`)
			.get(clientId) as { api_token: string };

		// Restored under the versioned envelope bound to the client id.
		const { decryptCredential } = await import('#lib/server/crypto/credentialsCrypto.js');
		expect(decryptCredential('debrid-token', clientId, row.api_token)).toBe(token);
	});

	it('fails export closed when a stored token cannot be decrypted', async () => {
		const { DownloadClientManager } =
			await import('#lib/server/downloadClients/DownloadClientManager.js');
		const { getConfigurationBackupService } = await import('./ConfigurationBackupService');

		process.env.BETTER_AUTH_SECRET = 'backup-export-secret-A';
		await new DownloadClientManager().createClient({
			name: 'Real-Debrid',
			implementation: 'realdebrid',
			apiToken: 'unrecoverable-token',
			priority: 1
		});
		process.env.BETTER_AUTH_SECRET = 'backup-export-secret-B';

		await expect(
			getConfigurationBackupService().exportConfig('passphrase-12345')
		).rejects.toThrow();
	});
});

describe('ConfigurationBackupService timestamp round-trip', () => {
	afterEach(() => {
		testDb.db.delete(namingPresets).run();
		process.env.BETTER_AUTH_SECRET = DEFAULT_SECRET;
	});

	it('restores a system-section backup whose rows contain serialized Date columns', async () => {
		const { getConfigurationBackupService } = await import('./ConfigurationBackupService');

		process.env.BETTER_AUTH_SECRET = 'backup-timestamp-secret';
		const preset = {
			id: 'preset-1',
			name: 'My Preset',
			description: null,
			config: { movie: '{title}' },
			isBuiltIn: false
		};
		testDb.db.insert(namingPresets).values(preset).run();
		const savedAt = testDb.sqlite
			.prepare(`SELECT "created_at" FROM "naming_presets" WHERE "id" = ?`)
			.get(preset.id) as { created_at: number };

		const backup = await getConfigurationBackupService().exportConfig('passphrase-12345');
		testDb.db.delete(namingPresets).run();

		// A real backup round-trips through JSON (download → upload), which
		// serializes Date columns to ISO strings. Reproduce that exactly.
		const serialized = JSON.parse(JSON.stringify(backup)) as typeof backup;

		await getConfigurationBackupService().restoreConfig(serialized, {
			passphrase: 'passphrase-12345',
			sections: ['system']
		});

		const restored = testDb.sqlite
			.prepare(`SELECT "id", "created_at" FROM "naming_presets" WHERE "id" = ?`)
			.get(preset.id) as { id: string; created_at: number };
		expect(restored.id).toBe(preset.id);
		expect(restored.created_at).toBe(savedAt.created_at);
	});

	it('restores legacy backups whose Date columns were exported as empty objects', async () => {
		const { getConfigurationBackupService } = await import('./ConfigurationBackupService');
		const { encryptBackupPayload } = await import('#lib/server/crypto/backupCrypto.js');

		process.env.BETTER_AUTH_SECRET = 'backup-legacy-secret';
		const backup = {
			format: 'cinephage-config-backup' as const,
			version: 1 as const,
			createdAt: new Date().toISOString(),
			manifest: undefined,
			options: {},
			data: {
				namingPresets: [
					{
						id: 'legacy-preset',
						name: 'Legacy Preset',
						description: null,
						config: { movie: '{title}' },
						isBuiltIn: false,
						createdAt: {} as Record<string, never>
					}
				]
			},
			secrets: encryptBackupPayload({ tables: {} }, 'passphrase-12345')
		};

		await getConfigurationBackupService().restoreConfig(backup, {
			passphrase: 'passphrase-12345',
			sections: ['system']
		});

		const restored = testDb.sqlite
			.prepare(`SELECT "id", "created_at" FROM "naming_presets" WHERE "id" = ?`)
			.get('legacy-preset') as { id: string; created_at: number | null };
		expect(restored.id).toBe('legacy-preset');
		expect(restored.created_at).not.toBeNull();
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Regression coverage for the credential-rotation data-loss bug.
 *
 * `decryptRecordSecrets` replaced an undecryptable envelope with `null`, and
 * rotation's failure detector looked for the literal `cphg1.` string in the
 * row. By then it was gone, so `failed` stayed false, the null was
 * re-encrypted and persisted over the ciphertext, and the API still reported
 * a successful rotation. A missing ENCRYPTION_PREVIOUS_KEYS entry would
 * silently destroy every stored credential.
 *
 * Uses a throwaway SQLite file so the real rotation code path runs.
 */
const OLD_KEY = randomBytes(32).toString('base64');
const NEW_KEY = randomBytes(32).toString('base64');

vi.mock('#lib/server/db/connection.js', () => {
	const state: { sqlite: unknown } = { sqlite: null };
	return {
		getSharedSqliteConnection: () => state.sqlite,
		__setSharedSqliteConnection: (value: unknown) => {
			state.sqlite = value;
		}
	};
});

const connectionMock = (await import('#lib/server/db/connection.js')) as unknown as {
	__setSharedSqliteConnection: (value: unknown) => void;
};

describe('credential rotation', () => {
	let sqlite: import('better-sqlite3').Database;

	beforeEach(async () => {
		const Database = (await import('better-sqlite3')).default;
		sqlite = new Database(':memory:');
		connectionMock.__setSharedSqliteConnection(sqlite);
		sqlite.exec(`
			CREATE TABLE download_clients (
				id TEXT PRIMARY KEY,
				name TEXT,
				host TEXT,
				port INTEGER,
				username TEXT,
				password TEXT,
				api_token TEXT
			);
		`);
	});

	afterEach(() => {
		sqlite.close();
		delete process.env.ENCRYPTION_MASTER_KEY;
		delete process.env.ENCRYPTION_PREVIOUS_KEYS;
	});

	async function seedClient(password: string): Promise<string> {
		process.env.ENCRYPTION_MASTER_KEY = OLD_KEY;
		delete process.env.ENCRYPTION_PREVIOUS_KEYS;
		const { encryptCredential } = await import('./credentialsCrypto.js');
		const envelope = encryptCredential('dl-client-password', 'client-1', password);
		sqlite
			.prepare(
				`INSERT INTO download_clients (id, name, host, port, username, password)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run('client-1', 'qbit', 'localhost', 8080, 'admin', envelope);
		return envelope;
	}

	it('leaves an undecryptable ciphertext intact and reports the failure', async () => {
		const original = await seedClient('hunter2');

		// Rotate to a new key with NO previous-key fallback: the stored
		// envelope cannot be decrypted any more.
		process.env.ENCRYPTION_MASTER_KEY = NEW_KEY;
		const { rotateCredentials } = await import('./credentialRotation.js');

		const result = rotateCredentials();

		expect(result.failed).toBe(1);
		expect(result.failedRefs).toContain('download_clients:client-1');
		expect(result.rotated).toBe(0);

		const stored = sqlite
			.prepare(`SELECT password FROM download_clients WHERE id = 'client-1'`)
			.get() as { password: string };
		// The ciphertext must survive so the operator can still recover it by
		// putting the old key back into ENCRYPTION_PREVIOUS_KEYS.
		expect(stored.password).toBe(original);
		expect(stored.password).not.toBeNull();
	});

	it('re-encrypts onto the new key when the old key is listed as previous', async () => {
		const original = await seedClient('hunter2');

		process.env.ENCRYPTION_MASTER_KEY = NEW_KEY;
		process.env.ENCRYPTION_PREVIOUS_KEYS = OLD_KEY;
		const { rotateCredentials } = await import('./credentialRotation.js');

		const result = rotateCredentials();

		expect(result.failed).toBe(0);
		expect(result.rotated).toBe(1);
		expect(result.unchanged).toBe(0);

		const stored = sqlite
			.prepare(`SELECT password FROM download_clients WHERE id = 'client-1'`)
			.get() as { password: string };
		expect(stored.password).not.toBe(original);

		// With only the new key available, the rotated value must decrypt.
		delete process.env.ENCRYPTION_PREVIOUS_KEYS;
		const { decryptCredential } = await import('./credentialsCrypto.js');
		expect(decryptCredential('dl-client-password', 'client-1', stored.password)).toBe('hunter2');
	});

	it('does not abort when a registered table is empty', async () => {
		// Empty tables previously threw `no such column: x` while preparing the
		// UPDATE statement, aborting the whole rotation.
		sqlite.exec(`
			CREATE TABLE indexer_status (indexer_id TEXT PRIMARY KEY, cookies TEXT);
		`);
		process.env.ENCRYPTION_MASTER_KEY = NEW_KEY;

		const { rotateCredentials } = await import('./credentialRotation.js');
		expect(() => rotateCredentials()).not.toThrow();
	});
});

import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
	SECRET_FIELD_SPECS,
	decryptRecordSecrets,
	encryptRecordSecrets,
	findSecretFieldSpec,
	isAtRestSecretKeyName
} from './secretFields.js';
import { isEncryptedCredential } from './credentialsCrypto.js';

const MASTER = randomBytes(32).toString('base64');

function setKeyEnv(master?: string): void {
	if (master === undefined) {
		delete process.env.ENCRYPTION_MASTER_KEY;
	} else {
		process.env.ENCRYPTION_MASTER_KEY = master;
	}
}

afterEach(() => {
	setKeyEnv();
});

describe('isAtRestSecretKeyName', () => {
	it('covers the shared patterns plus the login-credential keys they miss', () => {
		expect(isAtRestSecretKeyName('apiKey')).toBe(true); // matches 'key'
		expect(isAtRestSecretKeyName('password')).toBe(true);
		expect(isAtRestSecretKeyName('cookie')).toBe(true);
		expect(isAtRestSecretKeyName('pass')).toBe(true); // exact, not substring
		expect(isAtRestSecretKeyName('uid')).toBe(true);
		expect(isAtRestSecretKeyName('username')).toBe(true);
		expect(isAtRestSecretKeyName('usemagnetlinks')).toBe(false);
		expect(isAtRestSecretKeyName('stripcyrillic')).toBe(false);
		expect(isAtRestSecretKeyName('protocol')).toBe(false);
		expect(isAtRestSecretKeyName('aggregate')).toBe(false);
	});
});

describe('encryptRecordSecrets / decryptRecordSecrets', () => {
	it('round-trips scalar secret fields and leaves non-secrets untouched', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('download_clients')!;
		const row: Record<string, unknown> = {
			id: 'client-1',
			name: 'qbit',
			password: 'hunter2',
			username: 'admin'
		};
		encryptRecordSecrets(spec, row);
		expect(isEncryptedCredential(row.password)).toBe(true);
		// dl-client username stays plaintext at rest (rowToClient ships it
		// publicly); NNTP is the surface that encrypts usernames.
		expect(row.username).toBe('admin');
		expect(row.name).toBe('qbit');
		decryptRecordSecrets(spec, row);
		expect(row.password).toBe('hunter2');
	});

	it('round-trips JSON config fields per-key (indexer settings shape)', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('indexers')!;
		const row: Record<string, unknown> = {
			id: 'idx-9',
			settings: {
				username: 'ruuser',
				password: 'rupass',
				uid: '12345',
				stripcyrillic: true,
				usemagnetlinks: false,
				protocol: 'torrent'
			}
		};
		encryptRecordSecrets(spec, row);
		const settings = row.settings as Record<string, unknown>;
		expect(isEncryptedCredential(settings.username)).toBe(true);
		expect(isEncryptedCredential(settings.password)).toBe(true);
		expect(settings.stripcyrillic).toBe(true);
		expect(settings.protocol).toBe('torrent');

		decryptRecordSecrets(spec, row);
		const decrypted = row.settings as Record<string, unknown>;
		expect(decrypted.username).toBe('ruuser');
		expect(decrypted.password).toBe('rupass');
		expect(decrypted.stripcyrillic).toBe(true);
	});

	it('round-trips JSON config fields when the column holds a JSON string (raw sqlite shape)', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('indexers')!;
		const row: Record<string, unknown> = {
			id: 'idx-str',
			settings: JSON.stringify({ username: 'u1', password: 'p1', protocol: 'torrent' })
		};
		encryptRecordSecrets(spec, row);
		expect(typeof row.settings).toBe('string');
		const encrypted = JSON.parse(row.settings as string) as Record<string, unknown>;
		expect(isEncryptedCredential(encrypted.username)).toBe(true);
		expect(encrypted.protocol).toBe('torrent');

		decryptRecordSecrets(spec, row);
		const decrypted = JSON.parse(row.settings as string) as Record<string, unknown>;
		expect(decrypted.username).toBe('u1');
		expect(decrypted.password).toBe('p1');
	});

	it('encrypts sensitive object values (m3u headers) and restores the object on decrypt', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('livetv_accounts')!;
		const headers = { Authorization: 'Bearer xyz', 'X-Extra': 'abc' };
		const row: Record<string, unknown> = {
			id: 'acc-1',
			m3u_config: { url: 'http://u:p@host/x.m3u', headers: { ...headers }, autoRefresh: true }
		};
		encryptRecordSecrets(spec, row);
		const cfg = row.m3u_config as Record<string, unknown>;
		expect(isEncryptedCredential(cfg.url)).toBe(true);
		expect(isEncryptedCredential(cfg.headers)).toBe(true);
		expect(cfg.autoRefresh).toBe(true);

		decryptRecordSecrets(spec, row);
		const decrypted = row.m3u_config as Record<string, unknown>;
		expect(decrypted.url).toBe('http://u:p@host/x.m3u');
		expect(decrypted.headers).toEqual(headers);
	});

	it('handles settings KV rows: scalar secrets and JSON blobs with inner secrets', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('settings')!;
		const scalar: Record<string, unknown> = { key: 'tmdb_api_key', value: 'abc123' };
		encryptRecordSecrets(spec, scalar);
		expect(isEncryptedCredential(scalar.value)).toBe(true);
		decryptRecordSecrets(spec, scalar);
		expect(scalar.value).toBe('abc123');

		const blob: Record<string, unknown> = {
			key: 'jackett_connection',
			value: JSON.stringify({ apiKey: 'jk', adminPassword: 'pw', baseUrl: 'http://x' })
		};
		encryptRecordSecrets(spec, blob);
		const inner = JSON.parse(blob.value as string) as Record<string, unknown>;
		expect(isEncryptedCredential(inner.apiKey)).toBe(true);
		expect(isEncryptedCredential(inner.adminPassword)).toBe(true);
		expect(inner.baseUrl).toBe('http://x');
		decryptRecordSecrets(spec, blob);
		const restored = JSON.parse(blob.value as string) as Record<string, unknown>;
		expect(restored.apiKey).toBe('jk');
		expect(restored.adminPassword).toBe('pw');
	});

	it('leaves non-secret settings rows completely untouched', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('settings')!;
		const row: Record<string, unknown> = { key: 'external_url', value: 'http://cinephage:3000' };
		encryptRecordSecrets(spec, row);
		expect(row).toEqual({ key: 'external_url', value: 'http://cinephage:3000' });
	});

	it('is idempotent (no double encryption) and plaintext-tolerant on decrypt', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('nntp_servers')!;
		const once: Record<string, unknown> = { id: 'srv-1', username: 'u', password: 'p' };
		encryptRecordSecrets(spec, once);
		const snapshot = { ...once };
		encryptRecordSecrets(spec, once);
		expect(once).toEqual(snapshot);

		const plaintextRow: Record<string, unknown> = {
			id: 'srv-2',
			username: 'u',
			password: 'p'
		};
		decryptRecordSecrets(spec, plaintextRow);
		expect(plaintextRow).toEqual({ id: 'srv-2', username: 'u', password: 'p' });
	});

	it('never encrypts empty strings (presence flags rely on emptiness)', () => {
		setKeyEnv(MASTER);
		const spec = findSecretFieldSpec('download_clients')!;
		const row: Record<string, unknown> = { id: 'c1', password: '' };
		encryptRecordSecrets(spec, row);
		expect(row.password).toBe('');
	});

	it('every spec covers a table the registry claims', () => {
		const tables = SECRET_FIELD_SPECS.map((s) => s.table);
		expect(new Set(tables).size).toBe(tables.length); // no dup tables
		expect(tables).toContain('indexer_status');
		expect(tables).toContain('captcha_solver_settings');
		expect(tables).toContain('nzb_stream_mounts');
	});
});

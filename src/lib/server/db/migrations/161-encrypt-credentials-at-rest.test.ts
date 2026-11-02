import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';
import { isEncryptedCredential, decryptCredential } from '#lib/server/crypto/credentialsCrypto.js';
import { encryptApiKey } from '#lib/server/crypto/apiKeyCrypto.js';
import { encryptDebridToken } from '#lib/server/crypto/debridTokenCrypto.js';

/**
 * Migration 161: everything in the secret-field registry is enveloped in
 * place (JSON-string rows included), the three legacy surfaces re-encode onto
 * the same envelope, and the migration is idempotent + plaintext-tolerant.
 */

describe('migration 161 — encrypt credentials at rest', () => {
	const testDb: TestDatabase = createTestDb();

	it('encrypts indexer settings JSON secrets and settings KV rows in place', async () => {
		const sqlite = testDb.sqlite;

		sqlite
			.prepare(
				`INSERT INTO indexers (id, name, definition_id, enabled, base_url, priority, settings)
				 VALUES ('idx-1', 'RuTracker', 'rutracker', 1, 'https://rutracker.org', 25, ?)`
			)
			.run(
				JSON.stringify({
					username: 'ruuser',
					password: 'rupass',
					uid: '424242',
					stripcyrillic: true,
					protocol: 'torrent'
				})
			);

		sqlite
			.prepare(`INSERT INTO settings (key, value) VALUES ('tmdb_api_key', 'plain-tmdb-key')`)
			.run();

		const { migration_v161 } = await import('./161-encrypt-credentials-at-rest.js');
		migration_v161.apply(sqlite);

		const indexerRow = sqlite.prepare(`SELECT settings FROM indexers WHERE id = 'idx-1'`).get() as {
			settings: string;
		};
		const settings = JSON.parse(indexerRow.settings) as Record<string, unknown>;
		expect(isEncryptedCredential(settings.username)).toBe(true);
		expect(isEncryptedCredential(settings.password)).toBe(true);
		expect(isEncryptedCredential(settings.uid)).toBe(true);
		expect(settings.stripcyrillic).toBe(true);
		expect(settings.protocol).toBe('torrent');
		expect(decryptCredential('indexer-settings', 'idx-1', settings.username as string)).toBe(
			'ruuser'
		);
		expect(decryptCredential('indexer-settings', 'idx-1', settings.password as string)).toBe(
			'rupass'
		);

		const settingRow = sqlite
			.prepare(`SELECT value FROM settings WHERE key = 'tmdb_api_key'`)
			.get() as { value: string };
		expect(isEncryptedCredential(settingRow.value)).toBe(true);
		expect(decryptCredential('setting', 'tmdb_api_key', settingRow.value)).toBe('plain-tmdb-key');

		// Idempotent: second run changes nothing.
		migration_v161.apply(sqlite);
		const after = sqlite.prepare(`SELECT settings FROM indexers WHERE id = 'idx-1'`).get() as {
			settings: string;
		};
		expect(after.settings).toBe(indexerRow.settings);
	});

	it('encrypts download-client passwords and NNTP credentials', async () => {
		const sqlite = testDb.sqlite;

		sqlite
			.prepare(
				`INSERT INTO download_clients (id, name, implementation, enabled, host, port, use_ssl,
				 password, priority, remove_after_import, allow_movies, allow_tv, movie_category,
				 tv_category, recent_priority, older_priority, initial_state, created_at, updated_at)
				 VALUES ('dc-1', 'qBit', 'qbittorrent', 1, '10.0.0.5', 8080, 0, 'pw-plain', 1, 0, 1, 1,
				 'movies', 'tv', 'normal', 'normal', 'start', ?, ?)`
			)
			.run(new Date().toISOString(), new Date().toISOString());

		sqlite
			.prepare(
				`INSERT INTO nntp_servers (id, name, host, port, use_ssl, username, password,
					 max_connections, priority, enabled, auto_fetched, created_at, updated_at)
				 VALUES ('nntp-1', 'Usenet', 'news.example.com', 563, 1, 'newsuser', 'newspass',
				 10, 1, 1, 0, ?, ?)`
			)
			.run(new Date().toISOString(), new Date().toISOString());

		const { migration_v161 } = await import('./161-encrypt-credentials-at-rest.js');
		migration_v161.apply(sqlite);

		const dc = sqlite.prepare(`SELECT password FROM download_clients WHERE id = 'dc-1'`).get() as {
			password: string;
		};
		expect(isEncryptedCredential(dc.password)).toBe(true);
		expect(decryptCredential('dl-client-password', 'dc-1', dc.password)).toBe('pw-plain');

		const nntp = sqlite
			.prepare(`SELECT username, password FROM nntp_servers WHERE id = 'nntp-1'`)
			.get() as { username: string; password: string };
		expect(isEncryptedCredential(nntp.username)).toBe(true);
		expect(isEncryptedCredential(nntp.password)).toBe(true);
		expect(decryptCredential('nntp-server', 'nntp-1', nntp.username)).toBe('newsuser');
		expect(decryptCredential('nntp-server', 'nntp-1', nntp.password)).toBe('newspass');
	});

	it('re-encodes legacy iv:tag:ct blobs onto the versioned envelope', async () => {
		const sqlite = testDb.sqlite;

		sqlite
			.prepare(
				`INSERT INTO media_browser_servers (id, name, server_type, host, api_key, enabled,
					 on_import, on_upgrade, on_rename, on_delete, created_at, updated_at)
				 VALUES ('mb-1', 'JF', 'jellyfin', 'http://jf:8096', ?, 1, 1, 1, 1, 1, ?, ?)`
			)
			.run(
				encryptApiKey('media-browser-legacy-key'),
				new Date().toISOString(),
				new Date().toISOString()
			);

		sqlite
			.prepare(
				`INSERT INTO download_clients (id, name, implementation, enabled, host, port, use_ssl,
					 api_token, priority, remove_after_import, allow_movies, allow_tv, movie_category,
					 tv_category, recent_priority, older_priority, initial_state, created_at, updated_at)
				 VALUES ('dc-2', 'RD', 'realdebrid', 1, 'api.real-debrid.com', 443, 0, ?, 1, 1, 1, 1,
				 'movies', 'tv', 'normal', 'normal', 'start', ?, ?)`
			)
			.run(
				encryptDebridToken('debrid-legacy-token'),
				new Date().toISOString(),
				new Date().toISOString()
			);

		const { migration_v161 } = await import('./161-encrypt-credentials-at-rest.js');
		migration_v161.apply(sqlite);

		const mb = sqlite
			.prepare(`SELECT api_key FROM media_browser_servers WHERE id = 'mb-1'`)
			.get() as { api_key: string };
		expect(isEncryptedCredential(mb.api_key)).toBe(true);
		expect(decryptCredential('media-browser-api-key', 'mb-1', mb.api_key)).toBe(
			'media-browser-legacy-key'
		);

		const dc = sqlite.prepare(`SELECT api_token FROM download_clients WHERE id = 'dc-2'`).get() as {
			api_token: string;
		};
		expect(isEncryptedCredential(dc.api_token)).toBe(true);
		expect(decryptCredential('debrid-token', 'dc-2', dc.api_token)).toBe('debrid-legacy-token');
	});

	it('leaves undecryptable legacy rows untouched (fail-closed, no data loss)', async () => {
		const sqlite = testDb.sqlite;
		// A value that looks like a legacy triplet but decrypts to null because
		// it was not produced by apiKeyCrypto under the current secret.
		const bogus = 'deadbeef:cafebabe:feedface';

		sqlite
			.prepare(
				`INSERT INTO media_browser_servers (id, name, server_type, host, api_key, enabled,
					 on_import, on_upgrade, on_rename, on_delete, created_at, updated_at)
				 VALUES ('mb-2', 'JF2', 'jellyfin', 'http://jf2:8096', ?, 1, 1, 1, 1, 1, ?, ?)`
			)
			.run(bogus, new Date().toISOString(), new Date().toISOString());

		const { migration_v161 } = await import('./161-encrypt-credentials-at-rest.js');
		expect(() => migration_v161.apply(sqlite)).not.toThrow();

		const row = sqlite
			.prepare(`SELECT api_key FROM media_browser_servers WHERE id = 'mb-2'`)
			.get() as { api_key: string };
		expect(row.api_key).toBe(bogus);
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});
});

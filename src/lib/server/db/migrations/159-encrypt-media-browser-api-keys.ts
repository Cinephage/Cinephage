import type { MigrationDefinition } from '../migration-helpers.js';
import { encryptApiKey } from '#lib/server/crypto/apiKeyCrypto.js';

/**
 * Version 159: encrypt media_browser_servers.api_key at rest.
 *
 * Server credentials were stored in plaintext. Existing rows are encrypted
 * in place with the same AES-256-GCM scheme used for user API key secrets
 * (key derived from BETTER_AUTH_SECRET). Values that already look like
 * ciphertext (three hex colon-separated segments) are left alone, so the
 * migration is idempotent.
 */
export const migration_v159: MigrationDefinition = {
	version: 159,
	name: 'encrypt_media_browser_api_keys',
	apply: (sqlite) => {
		const rows = sqlite.prepare(`SELECT id, api_key FROM media_browser_servers`).all() as Array<{
			id: string;
			api_key: string;
		}>;

		const update = sqlite.prepare(`UPDATE media_browser_servers SET api_key = ? WHERE id = ?`);

		for (const row of rows) {
			const parts = row.api_key.split(':');
			const looksEncrypted = parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
			if (looksEncrypted || !row.api_key) {
				continue;
			}
			update.run(encryptApiKey(row.api_key), row.id);
		}
	}
};

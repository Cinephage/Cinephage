import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';
import { encryptRecordSecrets, SECRET_FIELD_SPECS } from '#lib/server/crypto/secretFields.js';
import { encryptCredential, isEncryptedCredential } from '#lib/server/crypto/credentialsCrypto.js';
import { decryptApiKey } from '#lib/server/crypto/apiKeyCrypto.js';
import { decryptDebridToken } from '#lib/server/crypto/debridTokenCrypto.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 161: Encrypt all remaining plaintext third-party credentials at rest.
 *
 * Walks the secret-field registry (download-client passwords, indexer settings
 * JSONs, subtitle-provider credentials, LiveTV provider configs, secret
 * settings rows incl. the Jackett/Prowlarr connection blobs, captcha proxy
 * credentials, NNTP credentials, NZB mount passwords, indexer session
 * cookies) and envelops each secret field with the versioned `cphg1.`
 * AES-256-GCM format bound to its record via AAD.
 *
 * The three legacy encrypted surfaces (user API key secrets, media-browser
 * API keys, debrid tokens — `iv:tag:ct` from apiKeyCrypto/debridTokenCrypto)
 * are decrypted with their legacy modules and re-encoded onto the same
 * envelope so a single rotation path covers everything.
 *
 * Idempotent: envelope values pass through untouched; plaintext rows that
 * race this migration (or restore as plaintext) are tolerated by the
 * managers' dual-read.
 */
function isLegacyTriplet(value: string): boolean {
	const parts = value.split(':');
	return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
}

function reencryptLegacy(
	sqlite: Database.Database,
	options: {
		table: string;
		column: string;
		idColumn: string;
		purpose: string;
		decryptLegacy: (value: string) => string | null;
	}
): number {
	if (!tableExists(sqlite, options.table)) return 0;

	const rows = sqlite
		.prepare(
			`SELECT "${options.idColumn}" AS id, "${options.column}" AS value FROM "${options.table}"`
		)
		.all() as Array<{ id: string; value: string | null }>;

	let count = 0;
	const update = sqlite.prepare(
		`UPDATE "${options.table}" SET "${options.column}" = ? WHERE "${options.idColumn}" = ?`
	);

	for (const row of rows) {
		if (!row.value || isEncryptedCredential(row.value)) continue;
		if (!isLegacyTriplet(row.value)) continue; // plaintext tolerance

		const plaintext = options.decryptLegacy(row.value);
		if (plaintext === null) {
			logger.error(
				{ table: options.table, id: row.id },
				'[SchemaSync v161] Legacy credential failed to decrypt; row left untouched — ' +
					're-enter the credential in settings after startup completes.'
			);
			continue;
		}
		update.run(encryptCredential(options.purpose, row.id, plaintext), row.id);
		count++;
	}
	return count;
}

export const migration_v161: MigrationDefinition = {
	version: 161,
	name: 'encrypt_credentials_at_rest',
	apply(sqlite: Database.Database) {
		let encryptedFields = 0;
		let reencodedLegacy = 0;

		for (const spec of SECRET_FIELD_SPECS) {
			if (!tableExists(sqlite, spec.table)) continue;

			const rows = sqlite.prepare(`SELECT * FROM "${spec.table}"`).all() as Array<
				Record<string, unknown>
			>;

			for (const row of rows) {
				const before = JSON.stringify(row);
				encryptRecordSecrets(spec, row);
				if (JSON.stringify(row) === before) continue;

				const sets = Object.keys(row)
					.map((key) => `"${key}" = ?`)
					.join(', ');
				const values = Object.keys(row).map((key) =>
					typeof row[key] === 'object' && row[key] !== null
						? JSON.stringify(row[key])
						: (row[key] as string | number | null)
				);
				sqlite
					.prepare(`UPDATE "${spec.table}" SET ${sets} WHERE "${spec.idColumn}" = ?`)
					.run(...values, String(row[spec.idColumn]));
				encryptedFields++;
			}
		}

		// Legacy `iv:tag:ct` surfaces -> versioned envelope (single rotation path).
		reencodedLegacy += reencryptLegacy(sqlite, {
			table: 'userApiKeySecrets', // Better Auth camelCase table name
			column: 'encryptedKey',
			idColumn: 'id',
			purpose: 'user-api-key',
			decryptLegacy: decryptApiKey
		});
		reencodedLegacy += reencryptLegacy(sqlite, {
			table: 'media_browser_servers',
			column: 'api_key',
			idColumn: 'id',
			purpose: 'media-browser-api-key',
			decryptLegacy: decryptApiKey
		});
		reencodedLegacy += reencryptLegacy(sqlite, {
			table: 'download_clients',
			column: 'api_token',
			idColumn: 'id',
			purpose: 'debrid-token',
			decryptLegacy: decryptDebridToken
		});

		logger.info(
			{ encryptedFields, reencodedLegacy },
			'[SchemaSync v161] Credentials encrypted at rest'
		);
	}
};

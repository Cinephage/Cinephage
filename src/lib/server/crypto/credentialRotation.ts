import { getSharedSqliteConnection } from '#lib/server/db/connection.js';
import { createChildLogger } from '#lib/logging/index.js';
import { decryptCredential, encryptCredential, isEncryptedCredential } from './credentialsCrypto';
import { decryptRecordSecrets, encryptRecordSecrets, SECRET_FIELD_SPECS } from './secretFields';
import { decryptApiKey } from './apiKeyCrypto.js';
import { decryptDebridToken } from './debridTokenCrypto.js';

const logger = createChildLogger({ component: 'CredentialRotation', logDomain: 'system' });

/**
 * Rotate every stored credential onto the current encryption master key.
 *
 * Run after changing ENCRYPTION_MASTER_KEY (or BETTER_AUTH_SECRET when no
 * dedicated key is set) with the old key(s) listed in ENCRYPTION_PREVIOUS_KEYS:
 * decryption resolves old-key envelopes through the fallback list, then every
 * value is re-encrypted under the current key. Values that fail to decrypt
 * (no fallback covers them) are left untouched and reported — re-enter those
 * credentials in settings.
 */

export interface CredentialRotationResult {
	/** Rows re-encrypted under the current key. */
	rotated: number;
	/** Rows whose ciphertext could not be decrypted with any available key. */
	failed: number;
	failedRefs: string[];
	/** Rows already on the current key (no change needed). */
	unchanged: number;
}

interface LegacySurface {
	table: string;
	column: string;
	idColumn: string;
	purpose: string;
	decryptLegacy: (value: string) => string | null;
}

const LEGACY_SURFACES: LegacySurface[] = [
	{
		table: 'user_api_key_secrets',
		column: 'encrypted_key',
		idColumn: 'id',
		purpose: 'user-api-key',
		decryptLegacy: decryptApiKey
	},
	{
		table: 'media_browser_servers',
		column: 'api_key',
		idColumn: 'id',
		purpose: 'media-browser-api-key',
		decryptLegacy: decryptApiKey
	},
	{
		table: 'download_clients',
		column: 'api_token',
		idColumn: 'id',
		purpose: 'debrid-token',
		decryptLegacy: decryptDebridToken
	}
];

function isLegacyTriplet(value: string): boolean {
	const parts = value.split(':');
	return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
}

export function rotateCredentials(): CredentialRotationResult {
	const sqlite = getSharedSqliteConnection();
	const result: CredentialRotationResult = { rotated: 0, failed: 0, failedRefs: [], unchanged: 0 };

	const tableExists = (name: string) =>
		sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

	// Registry surfaces: decrypt (kid fallback inside decryptCredential), then
	// re-encrypt. A row whose secret fails to decrypt keeps its old ciphertext.
	for (const spec of SECRET_FIELD_SPECS) {
		if (!tableExists(spec.table)) continue;

		const rows = sqlite.prepare(`SELECT * FROM "${spec.table}"`).all() as Array<
			Record<string, unknown>
		>;
		const update = sqlite.prepare(
			`UPDATE "${spec.table}" SET ${Object.keys(rows[0] ?? { x: 1 })
				.filter((key) => key !== spec.idColumn)
				.map((key) => `"${key}" = ?`)
				.join(', ')} WHERE "${spec.idColumn}" = ?`
		);

		for (const row of rows) {
			const before = JSON.stringify(row);
			decryptRecordSecrets(spec, row);
			// Detect a failed decrypt: any secret column still holding an envelope.
			let failed = false;
			for (const value of Object.values(row)) {
				if (typeof value === 'string' && value.includes('cphg1.')) failed = true;
			}
			if (failed) {
				result.failed++;
				result.failedRefs.push(`${spec.table}:${String(row[spec.idColumn])}`);
				continue;
			}
			encryptRecordSecrets(spec, row);
			const after = JSON.stringify(row);
			if (after === before) {
				result.unchanged++;
				continue;
			}
			const values = Object.keys(row)
				.filter((key) => key !== spec.idColumn)
				.map((key) =>
					typeof row[key] === 'object' && row[key] !== null
						? JSON.stringify(row[key])
						: (row[key] as string | number | null)
				);
			update.run(...values, String(row[spec.idColumn]));
			result.rotated++;
		}
	}

	// Legacy-format columns (pre-161 blobs may survive failed rotations).
	for (const surface of LEGACY_SURFACES) {
		if (!tableExists(surface.table)) continue;

		const rows = sqlite
			.prepare(
				`SELECT "${surface.idColumn}" AS id, "${surface.column}" AS value FROM "${surface.table}"`
			)
			.all() as Array<{ id: string; value: string | null }>;
		const update = sqlite.prepare(
			`UPDATE "${surface.table}" SET "${surface.column}" = ? WHERE "${surface.idColumn}" = ?`
		);

		for (const row of rows) {
			if (!row.value) continue;
			if (isEncryptedCredential(row.value)) {
				// Verify it decrypts under an available key; re-encrypting with the
				// current key is idempotent-safe only when decrypt succeeds.
				const plaintext = decryptCredential(
					surface.purpose,
					row.id,
					row.value,
					`rotate:${surface.table}:${row.id}`
				);
				if (plaintext === null) {
					result.failed++;
					result.failedRefs.push(`${surface.table}:${row.id}`);
					continue;
				}
				const fresh = encryptCredential(surface.purpose, row.id, plaintext);
				if (fresh === row.value) {
					result.unchanged++;
				} else {
					update.run(fresh, row.id);
					result.rotated++;
				}
			} else if (isLegacyTriplet(row.value)) {
				const plaintext = surface.decryptLegacy(row.value);
				if (plaintext === null) {
					result.failed++;
					result.failedRefs.push(`${surface.table}:${row.id}`);
					continue;
				}
				update.run(encryptCredential(surface.purpose, row.id, plaintext), row.id);
				result.rotated++;
			}
			// Plain plaintext values are the migration's job (idempotent).
		}
	}

	logger.info(
		{ rotated: result.rotated, failed: result.failed, unchanged: result.unchanged },
		'[CredentialRotation] Credential rotation complete'
	);
	return result;
}

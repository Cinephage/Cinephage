import { isSensitiveKeyName } from '#lib/shared/sensitiveSettings.js';

import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from './credentialsCrypto.js';

/**
 * Single registry describing which fields hold third-party secrets at rest,
 * shared by the encrypting migration (161), the runtime managers, and the
 * configuration-backup portable transforms. Encryption and redaction are
 * separate layers: this module decides what is ENCRYPTED AT REST; what the
 * API shows remains each redaction helper's concern.
 *
 * `username` is encrypted at rest (it is half of a credential pair) but stays
 * visible in redacted API output — the two lists intentionally differ.
 */

/** Keys the shared sensitive-name patterns miss but that are credentials at rest. */
const EXTRA_AT_REST_KEYS = new Set(['pass', 'uid', 'username']);

export function isAtRestSecretKeyName(key: string): boolean {
	const lower = key.toLowerCase();
	return isSensitiveKeyName(key) || EXTRA_AT_REST_KEYS.has(lower);
}

export interface JsonSecretField {
	/** JSON column with per-key encryption of secret-looking keys inside. */
	column: string;
	/** Keys the name-predicate misses but that are secrets for this column
	 * (e.g. m3u `url` embeds credentials). */
	extraKeys?: string[];
}

export interface SecretFieldSpec {
	/** AAD purpose string (`purpose:recordId`). */
	purpose: string;
	/** SQLite table name. */
	table: string;
	/** Column holding the record id used in the AAD binding. */
	idColumn: string;
	/** String columns whose entire value is a secret. */
	scalarFields?: string[];
	/** JSON columns with per-key encryption inside. */
	jsonFields?: JsonSecretField[];
	/**
	 * Key/value tables (settings, captcha_solver_settings): encrypt the value
	 * row when its key is listed here. Values that parse as JSON objects are
	 * walked per-key like jsonFields.
	 */
	kvSecretKeys?: string[];
}

export const SECRET_FIELD_SPECS: SecretFieldSpec[] = [
	{
		purpose: 'dl-client-password',
		table: 'download_clients',
		idColumn: 'id',
		scalarFields: ['password']
	},
	{
		purpose: 'indexer-settings',
		table: 'indexers',
		idColumn: 'id',
		jsonFields: [{ column: 'settings' }]
	},
	{
		purpose: 'indexer-cookies',
		table: 'indexer_status',
		idColumn: 'indexer_id',
		scalarFields: ['cookies']
	},
	{
		purpose: 'subtitle-provider',
		table: 'subtitle_providers',
		idColumn: 'id',
		scalarFields: ['api_key', 'username', 'password']
	},
	{
		purpose: 'livetv-config',
		table: 'livetv_accounts',
		idColumn: 'id',
		jsonFields: [
			{ column: 'stalker_config' },
			{ column: 'xstream_config' },
			{ column: 'm3u_config', extraKeys: ['url', 'headers'] }
		]
	},
	{
		purpose: 'setting',
		table: 'settings',
		idColumn: 'key',
		kvSecretKeys: [
			'tmdb_api_key',
			'tvdb_api_key',
			'tvdb_api_pin',
			'jackett_connection',
			'prowlarr_connection'
		]
	},
	{
		purpose: 'captcha-setting',
		table: 'captcha_solver_settings',
		idColumn: 'key',
		kvSecretKeys: ['proxy_username', 'proxy_password']
	},
	{
		purpose: 'nntp-server',
		table: 'nntp_servers',
		idColumn: 'id',
		scalarFields: ['username', 'password']
	},
	{
		purpose: 'nzb-mount-password',
		table: 'nzb_stream_mounts',
		idColumn: 'id',
		scalarFields: ['password']
	}
];

export function findSecretFieldSpec(table: string): SecretFieldSpec | undefined {
	return SECRET_FIELD_SPECS.find((spec) => spec.table === table);
}

/**
 * Look a spec up by either its SQL table name (`download_clients`) or a
 * camelCase alias (`downloadClients`) — migrations walk raw snake_case rows
 * while managers and the backup service see Drizzle camelCase properties.
 */
export function findSecretFieldSpecByAlias(name: string): SecretFieldSpec | undefined {
	const normalized = normalizeFieldName(name);
	return SECRET_FIELD_SPECS.find((spec) => normalizeFieldName(spec.table) === normalized);
}

/** Case/underscore-insensitive field-name comparison (`api_key` ≡ `apiKey`). */
function normalizeFieldName(name: string): string {
	return name.replace(/_/g, '').toLowerCase();
}

function matchesField(fieldName: string, key: string): boolean {
	return normalizeFieldName(fieldName) === normalizeFieldName(key);
}

function jsonFieldSecretKeys(field: JsonSecretField): (key: string) => boolean {
	const extra = field.extraKeys ?? [];
	return (key: string) => isAtRestSecretKeyName(key) || extra.includes(key);
}

function encryptJsonValue(
	purpose: string,
	recordId: string,
	key: string,
	value: unknown,
	isSecretKey: (key: string) => boolean
): unknown {
	if (value === null || value === undefined) return value;
	if (!isSecretKey(key)) {
		return typeof value === 'object'
			? encryptJsonObject(
					purpose,
					recordId,
					value as Record<string, unknown> | unknown[],
					isSecretKey
				)
			: value;
	}
	if (typeof value === 'string') {
		return isEncryptedCredential(value) ? value : encryptCredential(purpose, recordId, value);
	}
	if (typeof value === 'object') {
		// Sensitive object (e.g. m3u headers) — encrypt as one envelope string.
		return encryptCredential(purpose, recordId, JSON.stringify(value));
	}
	return value;
}

function encryptJsonObject(
	purpose: string,
	recordId: string,
	value: Record<string, unknown> | unknown[],
	isSecretKey: (key: string) => boolean
): Record<string, unknown> | unknown[] {
	if (Array.isArray(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = encryptJsonValue(purpose, recordId, k, v, isSecretKey);
	}
	return out;
}

function decryptJsonValue(purpose: string, recordId: string, value: unknown): unknown {
	if (typeof value === 'string' && isEncryptedCredential(value)) {
		const plaintext = decryptCredential(purpose, recordId, value);
		// Encrypted objects (e.g. m3u header maps) were stored stringified.
		if (typeof plaintext === 'string' && plaintext.startsWith('{')) {
			try {
				const parsed = JSON.parse(plaintext);
				if (parseJsonObject(parsed)) return parsed;
			} catch {
				// A secret that merely looks like JSON — return as-is.
			}
		}
		return plaintext;
	}
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return decryptJsonObject(purpose, recordId, value as Record<string, unknown>);
	}
	return value;
}

function decryptJsonObject(
	purpose: string,
	recordId: string,
	value: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = decryptJsonValue(purpose, recordId, v);
	}
	return out;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/**
 * Encrypt every secret field of a row (mutates and returns the row).
 * Idempotent: already-enveloped values pass through untouched. NULL/empty
 * values stay untouched (presence flags like `hasPassword` rely on emptiness).
 */
export function encryptRecordSecrets(spec: SecretFieldSpec, row: Record<string, unknown>): void {
	const recordId = String(row[spec.idColumn] ?? '');

	for (const field of spec.scalarFields ?? []) {
		for (const key of Object.keys(row)) {
			if (!matchesField(field, key)) continue;
			const value = row[key];
			if (typeof value === 'string' && value && !isEncryptedCredential(value)) {
				row[key] = encryptCredential(spec.purpose, recordId, value);
			}
		}
	}

	for (const field of spec.jsonFields ?? []) {
		for (const key of Object.keys(row)) {
			if (!matchesField(field.column, key)) continue;
			const raw = row[key];
			// Drizzle hands back parsed objects; raw sqlite (migrations) returns
			// JSON-encoded strings. Tolerate both.
			const json = parseJsonObject(raw) ?? tryParseJson(typeof raw === 'string' ? raw : '');
			if (json) {
				const walked = encryptJsonObject(spec.purpose, recordId, json, jsonFieldSecretKeys(field));
				row[key] = typeof raw === 'string' ? JSON.stringify(walked) : walked;
			}
		}
	}

	if (spec.kvSecretKeys) {
		const key = String(row['key'] ?? '');
		if (spec.kvSecretKeys.includes(key)) {
			const value = row['value'];
			if (typeof value === 'string' && value && !isEncryptedCredential(value)) {
				const asJson = tryParseJson(value);
				row['value'] = asJson
					? JSON.stringify(encryptJsonObject(spec.purpose, key, asJson, isAtRestSecretKeyName))
					: encryptCredential(spec.purpose, key, value);
			}
		}
	}
}

/**
 * Decrypt every secret field of a row (mutates the row).
 * Non-enveloped values pass through untouched (plaintext tolerance for rows
 * that raced the migration or were restored by older tooling).
 */
export function decryptRecordSecrets(spec: SecretFieldSpec, row: Record<string, unknown>): void {
	const recordId = String(row[spec.idColumn] ?? '');

	for (const field of spec.scalarFields ?? []) {
		for (const key of Object.keys(row)) {
			if (!matchesField(field, key)) continue;
			const value = row[key];
			if (typeof value === 'string' && isEncryptedCredential(value)) {
				row[key] = decryptCredential(spec.purpose, recordId, value);
			}
		}
	}

	for (const field of spec.jsonFields ?? []) {
		for (const key of Object.keys(row)) {
			if (!matchesField(field.column, key)) continue;
			const raw = row[key];
			const json = parseJsonObject(raw) ?? tryParseJson(typeof raw === 'string' ? raw : '');
			if (json) {
				const walked = decryptJsonObject(spec.purpose, recordId, json);
				row[key] = typeof raw === 'string' ? JSON.stringify(walked) : walked;
			}
		}
	}

	if (spec.kvSecretKeys) {
		const key = String(row['key'] ?? '');
		if (spec.kvSecretKeys.includes(key)) {
			const value = row['value'];
			if (typeof value === 'string' && isEncryptedCredential(value)) {
				const plaintext = decryptCredential(spec.purpose, key, value);
				row['value'] = plaintext === null ? '' : plaintext;
			} else if (typeof value === 'string' && value) {
				const asJson = tryParseJson(value);
				if (asJson) {
					const walked = decryptJsonObject(spec.purpose, key, asJson);
					// Only replace when a secret actually decrypted inside.
					if (JSON.stringify(walked) !== JSON.stringify(asJson)) {
						row['value'] = JSON.stringify(walked);
					}
				}
			}
		}
	}
}

function tryParseJson(value: string): Record<string, unknown> | null {
	if (!value.startsWith('{')) return null;
	try {
		const parsed = JSON.parse(value);
		return parseJsonObject(parsed);
	} catch {
		return null;
	}
}

/**
 * Encrypt secret-looking keys inside a plain JSON object (used by managers
 * whose config objects are not whole-table rows, e.g. indexer settings).
 * Returns a new object; idempotent on already-enveloped values.
 */
export function encryptSecretJsonValues(
	purpose: string,
	recordId: string,
	value: Record<string, unknown>,
	isSecretKey: (key: string) => boolean = isAtRestSecretKeyName
): Record<string, unknown> {
	return encryptJsonObject(purpose, recordId, value, isSecretKey) as Record<string, unknown>;
}

/** Decrypt envelope values inside a plain JSON object. Returns a new object. */
export function decryptSecretJsonValues(
	purpose: string,
	recordId: string,
	value: Record<string, unknown>
): Record<string, unknown> {
	return decryptJsonObject(purpose, recordId, value);
}

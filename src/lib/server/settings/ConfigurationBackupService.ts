import type { AnySQLiteColumn, AnySQLiteTable, SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { getTableColumns } from 'drizzle-orm';

import { ValidationError } from '#lib/errors/index.js';
import { logger } from '#lib/logging/index.js';
import {
	decryptBackupPayload,
	encryptBackupPayload,
	type EncryptedBackupPayload
} from '#lib/server/crypto/backupCrypto.js';
import { decryptDebridToken } from '#lib/server/crypto/debridTokenCrypto.js';
import { decryptApiKey } from '#lib/server/crypto/apiKeyCrypto.js';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential,
	parseCredentialEnvelope
} from '#lib/server/crypto/credentialsCrypto.js';
import {
	encryptRecordSecrets,
	findSecretFieldSpecByAlias
} from '#lib/server/crypto/secretFields.js';
import { db } from '#lib/server/db/index.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { getCookieStore } from '#lib/server/indexers/auth/CookieStore.js';
import {
	captchaSolverSettings,
	channelCategories,
	channelLineupBackups,
	channelLineupItems,
	customFormats,
	delayProfiles,
	downloadClients,
	indexers,
	languageProfiles,
	languageSettings,
	libraries,
	libraryRootFolders,
	librarySettings,
	livetvAccounts,
	mediaBrowserServers,
	monitoringSettings,
	namingPresets,
	namingSettings,
	nntpServers,
	rootFolders,
	scoringProfiles,
	settings,
	smartLists,
	stalkerPortals,
	subtitleProviders,
	taskSettings,
	indexerStatus
} from '#lib/server/db/schema.js';

export interface ConfigurationBackupFile {
	format: 'cinephage-config-backup';
	version: 1;
	createdAt: string;
	manifest?: ConfigurationBackupManifest;
	options?: {
		includeIndexerCookies?: boolean;
	};
	data: Record<string, unknown[]>;
	secrets: EncryptedBackupPayload;
}

type TableName =
	| 'settings'
	| 'monitoringSettings'
	| 'captchaSolverSettings'
	| 'taskSettings'
	| 'scoringProfiles'
	| 'customFormats'
	| 'downloadClients'
	| 'rootFolders'
	| 'libraries'
	| 'libraryRootFolders'
	| 'librarySettings'
	| 'namingSettings'
	| 'namingPresets'
	| 'delayProfiles'
	| 'languageProfiles'
	| 'languageSettings'
	| 'subtitleProviders'
	| 'indexers'
	| 'nntpServers'
	| 'mediaBrowserServers'
	| 'stalkerPortals'
	| 'livetvAccounts'
	| 'channelCategories'
	| 'channelLineupItems'
	| 'channelLineupBackups'
	| 'smartLists';

export type BackupSectionName =
	'system' | 'profiles' | 'downloads' | 'indexers' | 'subtitles' | 'integrations' | 'liveTv';

export interface ConfigurationBackupSectionManifest {
	id: BackupSectionName;
	label: string;
	tableNames: string[];
	totalRows: number;
}

export interface ConfigurationBackupManifest {
	sectionOrder: BackupSectionName[];
	sections: ConfigurationBackupSectionManifest[];
	totalTables: number;
	totalRows: number;
	supportsRestoreModes: Array<'apply'>;
}

export interface RestoreConfigOptions {
	passphrase: string;
	sections?: BackupSectionName[];
	mode?: 'apply' | 'replace';
}

export interface RestoreConfigResult {
	restoredSections: BackupSectionName[];
	restoredTables: TableName[];
	secretsRestored: boolean;
	warnings: string[];
}

interface BackupSecretPayload {
	tables: Record<string, Record<string, unknown>>;
	indexerCookies?: Record<
		string,
		{
			cookies: Record<string, string>;
			expiry: string;
		}
	>;
}

interface ExportConfigOptions {
	includeIndexerCookies?: boolean;
}

interface PreparedRestoreTable {
	config: TableBackupConfig;
	rows: Record<string, unknown>[];
}

interface TableBackupConfig {
	name: TableName;
	table: AnySQLiteTable;
	getRecordKey: (row: Record<string, unknown>) => string;
	conflictTarget: AnySQLiteColumn | AnySQLiteColumn[];
}

const BACKUP_VERSION = 1 as const;
const BACKUP_FORMAT = 'cinephage-config-backup' as const;

const SECRET_KEY_NAMES = new Set([
	'api_key',
	'apikey',
	'password',
	'username',
	'token',
	'auth_token',
	'authtoken',
	'secret',
	'cookie',
	'cookies',
	'proxy_username',
	'proxy_password',
	'headers',
	'api_token',
	'apitoken'
]);

const TABLES: TableBackupConfig[] = [
	{
		name: 'settings',
		table: settings,
		getRecordKey: (row) => String(row.key),
		conflictTarget: settings.key
	},
	{
		name: 'monitoringSettings',
		table: monitoringSettings,
		getRecordKey: (row) => String(row.key),
		conflictTarget: monitoringSettings.key
	},
	{
		name: 'captchaSolverSettings',
		table: captchaSolverSettings,
		getRecordKey: (row) => String(row.key),
		conflictTarget: captchaSolverSettings.key
	},
	{
		name: 'taskSettings',
		table: taskSettings,
		getRecordKey: (row) => String(row.id),
		conflictTarget: taskSettings.id
	},
	{
		name: 'scoringProfiles',
		table: scoringProfiles,
		getRecordKey: (row) => String(row.id),
		conflictTarget: scoringProfiles.id
	},
	{
		name: 'customFormats',
		table: customFormats,
		getRecordKey: (row) => String(row.id),
		conflictTarget: customFormats.id
	},
	{
		name: 'downloadClients',
		table: downloadClients,
		getRecordKey: (row) => String(row.id),
		conflictTarget: downloadClients.id
	},
	{
		name: 'rootFolders',
		table: rootFolders,
		getRecordKey: (row) => String(row.id),
		conflictTarget: rootFolders.id
	},
	{
		name: 'libraries',
		table: libraries,
		getRecordKey: (row) => String(row.id),
		conflictTarget: libraries.id
	},
	{
		name: 'libraryRootFolders',
		table: libraryRootFolders,
		getRecordKey: (row) => `${String(row.libraryId)}:${String(row.rootFolderId)}`,
		conflictTarget: [libraryRootFolders.libraryId, libraryRootFolders.rootFolderId]
	},
	{
		name: 'librarySettings',
		table: librarySettings,
		getRecordKey: (row) => String(row.key),
		conflictTarget: librarySettings.key
	},
	{
		name: 'namingSettings',
		table: namingSettings,
		getRecordKey: (row) => String(row.key),
		conflictTarget: namingSettings.key
	},
	{
		name: 'namingPresets',
		table: namingPresets,
		getRecordKey: (row) => String(row.id),
		conflictTarget: namingPresets.id
	},
	{
		name: 'delayProfiles',
		table: delayProfiles,
		getRecordKey: (row) => String(row.id),
		conflictTarget: delayProfiles.id
	},
	{
		name: 'languageProfiles',
		table: languageProfiles,
		getRecordKey: (row) => String(row.id),
		conflictTarget: languageProfiles.id
	},
	{
		name: 'languageSettings',
		table: languageSettings,
		getRecordKey: (row) => String(row.id),
		conflictTarget: languageSettings.id
	},
	{
		name: 'subtitleProviders',
		table: subtitleProviders,
		getRecordKey: (row) => String(row.id),
		conflictTarget: subtitleProviders.id
	},
	{
		name: 'indexers',
		table: indexers,
		getRecordKey: (row) => String(row.id),
		conflictTarget: indexers.id
	},
	{
		name: 'nntpServers',
		table: nntpServers,
		getRecordKey: (row) => String(row.id),
		conflictTarget: nntpServers.id
	},
	{
		name: 'mediaBrowserServers',
		table: mediaBrowserServers,
		getRecordKey: (row) => String(row.id),
		conflictTarget: mediaBrowserServers.id
	},
	{
		name: 'stalkerPortals',
		table: stalkerPortals,
		getRecordKey: (row) => String(row.id),
		conflictTarget: stalkerPortals.id
	},
	{
		name: 'livetvAccounts',
		table: livetvAccounts,
		getRecordKey: (row) => String(row.id),
		conflictTarget: livetvAccounts.id
	},
	{
		name: 'channelCategories',
		table: channelCategories,
		getRecordKey: (row) => String(row.id),
		conflictTarget: channelCategories.id
	},
	{
		name: 'channelLineupItems',
		table: channelLineupItems,
		getRecordKey: (row) => String(row.id),
		conflictTarget: channelLineupItems.id
	},
	{
		name: 'channelLineupBackups',
		table: channelLineupBackups,
		getRecordKey: (row) => String(row.id),
		conflictTarget: channelLineupBackups.id
	},
	{
		name: 'smartLists',
		table: smartLists,
		getRecordKey: (row) => String(row.id),
		conflictTarget: smartLists.id
	}
];
const IMPORT_ORDER: TableBackupConfig[] = TABLES;

const SECTION_ORDER: BackupSectionName[] = [
	'system',
	'profiles',
	'downloads',
	'indexers',
	'subtitles',
	'integrations',
	'liveTv'
];

const SECTIONS: Array<{
	id: BackupSectionName;
	label: string;
	tableNames: TableName[];
}> = [
	{
		id: 'system',
		label: 'System & Libraries',
		tableNames: [
			'settings',
			'monitoringSettings',
			'captchaSolverSettings',
			'taskSettings',
			'rootFolders',
			'libraries',
			'libraryRootFolders',
			'librarySettings',
			'namingSettings',
			'namingPresets'
		]
	},
	{
		id: 'profiles',
		label: 'Profiles & Formats',
		tableNames: [
			'scoringProfiles',
			'customFormats',
			'delayProfiles',
			'languageProfiles',
			'languageSettings'
		]
	},
	{
		id: 'downloads',
		label: 'Download Clients',
		tableNames: ['downloadClients', 'nntpServers']
	},
	{
		id: 'indexers',
		label: 'Indexers',
		tableNames: ['indexers']
	},
	{
		id: 'subtitles',
		label: 'Subtitles',
		tableNames: ['subtitleProviders']
	},
	{
		id: 'integrations',
		label: 'External Integrations',
		tableNames: ['mediaBrowserServers', 'smartLists']
	},
	{
		id: 'liveTv',
		label: 'Live TV',
		tableNames: [
			'stalkerPortals',
			'livetvAccounts',
			'channelCategories',
			'channelLineupItems',
			'channelLineupBackups'
		]
	}
];

function normalizeSecretKey(value: string): string {
	return value.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function isKeyValueSecretEntry(tableName: TableName, row: Record<string, unknown>): boolean {
	if (!('key' in row) || typeof row.key !== 'string') {
		return false;
	}

	if (tableName === 'settings') {
		return [
			'tmdb_api_key',
			'tvdb_api_key',
			'tvdb_api_pin',
			'jackett_connection',
			'prowlarr_connection'
		].includes(row.key);
	}

	if (tableName === 'captchaSolverSettings') {
		return ['proxy_username', 'proxy_password'].includes(row.key);
	}

	return false;
}

/**
 * Portable-secrets transform: the backup payload carries PLAINTEXT so it can
 * be re-encrypted under the destination instance's master key on restore.
 * Walks a secrets tree and decrypts every credential envelope it contains.
 * Field names are irrelevant here — the AAD binds `purpose:recordId`, both of
 * which the walker knows. A failed decrypt aborts the backup (fail-closed).
 */
function decryptBackupSecretTree(purpose: string, recordKey: string, node: unknown): unknown {
	if (typeof node === 'string') {
		// Plain-boolean check (not the type-guard) so negative narrowing
		// doesn't reduce the string to `never` for the JSON-blob branch below.
		const envelope = parseCredentialEnvelope(node);
		if (envelope) {
			void envelope;
			const plaintext = decryptCredential(
				purpose,
				recordKey,
				node,
				`backup:${purpose}:${recordKey}`
			);
			if (plaintext === null) {
				throw new ValidationError(
					`Failed to decrypt ${purpose} secret for record ${recordKey}; backup aborted`
				);
			}
			return plaintext;
		}
		// JSON blobs (e.g. jackett_connection) carry envelopes inside.
		if (node.startsWith('{') && node.includes('cphg1.')) {
			try {
				const parsed = JSON.parse(node) as Record<string, unknown>;
				const walked = decryptBackupSecretTree(purpose, recordKey, parsed);
				return typeof walked === 'string' ? walked : JSON.stringify(walked);
			} catch (error) {
				if (error instanceof ValidationError) throw error;
				return node;
			}
		}
		return node;
	}
	if (Array.isArray(node)) {
		return node.map((item) => decryptBackupSecretTree(purpose, recordKey, item));
	}
	if (node !== null && typeof node === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			out[key] = decryptBackupSecretTree(purpose, recordKey, value);
		}
		return out;
	}
	return node;
}

function isSensitiveField(fieldName: string): boolean {
	return SECRET_KEY_NAMES.has(normalizeSecretKey(fieldName));
}

function extractSecrets(
	value: unknown,
	fieldName?: string
): { sanitized: unknown; secret?: unknown } {
	if (fieldName && isSensitiveField(fieldName)) {
		return { sanitized: null, secret: value };
	}

	if (Array.isArray(value)) {
		const sanitizedArray: unknown[] = [];
		const secretArray: unknown[] = [];
		let hasSecret = false;

		for (const item of value) {
			const extracted = extractSecrets(item);
			sanitizedArray.push(extracted.sanitized);
			if (extracted.secret !== undefined) {
				secretArray.push(extracted.secret);
				hasSecret = true;
			} else {
				secretArray.push(null);
			}
		}

		return {
			sanitized: sanitizedArray,
			secret: hasSecret ? secretArray : undefined
		};
	}

	// Dates must be treated as leaves: walking them with Object.entries (which
	// yields nothing) silently reduces them to `{}` in the exported backup.
	if (value instanceof Date) {
		return { sanitized: value };
	}

	if (value && typeof value === 'object') {
		const sanitizedObject: Record<string, unknown> = {};
		const secretObject: Record<string, unknown> = {};
		let hasSecret = false;

		for (const [key, nestedValue] of Object.entries(value)) {
			const extracted = extractSecrets(nestedValue, key);
			sanitizedObject[key] = extracted.sanitized;
			if (extracted.secret !== undefined) {
				secretObject[key] = extracted.secret;
				hasSecret = true;
			}
		}

		return {
			sanitized: sanitizedObject,
			secret: hasSecret ? secretObject : undefined
		};
	}

	return { sanitized: value };
}

function deepMergeRecord<T>(base: T, secret: unknown): T {
	if (secret === undefined || secret === null) {
		return base;
	}

	if (Array.isArray(base) && Array.isArray(secret)) {
		return base.map((item, index) => deepMergeRecord(item, secret[index])) as T;
	}

	if (base && typeof base === 'object' && !Array.isArray(base) && typeof secret === 'object') {
		const merged = { ...(base as Record<string, unknown>) };
		for (const [key, secretValue] of Object.entries(secret as Record<string, unknown>)) {
			merged[key] = key in merged ? deepMergeRecord(merged[key], secretValue) : secretValue;
		}
		return merged as T;
	}

	return secret as T;
}

/**
 * A backup file round-trips through JSON, which serializes Date values to
 * ISO strings. Drizzle's timestamp-mode columns expect Date instances on
 * write (`mapToDriverValue` calls `value.getTime()`), so restoring raw JSON
 * rows fails with "value.getTime is not a function". Convert each value
 * according to its drizzle column type before insert.
 */
function deserializeRestoredRow(
	table: AnySQLiteTable,
	row: Record<string, unknown>
): Record<string, unknown> {
	const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
	const converted: Record<string, unknown> = { ...row };

	for (const [key, column] of Object.entries(columns)) {
		const value = converted[key];
		if (value === null || value === undefined) continue;
		if (column.dataType === 'date') {
			if (typeof value === 'string' || typeof value === 'number') {
				const parsed = new Date(value);
				if (!Number.isNaN(parsed.getTime())) {
					converted[key] = parsed;
					continue;
				}
			}
			// Backups created before Date columns were preserved carry `{}` in
			// their place. The original value is unrecoverable, so drop the key
			// and let the schema default supply a fresh timestamp.
			delete converted[key];
		}
	}

	return converted;
}

function restoreExistingSensitiveValues<T>(incoming: T, existing: unknown, fieldName?: string): T {
	if (fieldName && isSensitiveField(fieldName) && incoming === null) {
		return existing as T;
	}

	if (Array.isArray(incoming) && Array.isArray(existing)) {
		return incoming.map((item, index) =>
			restoreExistingSensitiveValues(item, existing[index])
		) as T;
	}

	if (
		incoming &&
		typeof incoming === 'object' &&
		!Array.isArray(incoming) &&
		existing &&
		typeof existing === 'object' &&
		!Array.isArray(existing)
	) {
		const merged = { ...(incoming as Record<string, unknown>) };

		for (const [key, value] of Object.entries(merged)) {
			merged[key] = restoreExistingSensitiveValues(
				value,
				(existing as Record<string, unknown>)[key],
				key
			);
		}

		return merged as T;
	}

	return incoming;
}

function buildManifest(data: Record<string, unknown[]>): ConfigurationBackupManifest {
	const sections = SECTIONS.map((section) => ({
		id: section.id,
		label: section.label,
		tableNames: section.tableNames,
		totalRows: section.tableNames.reduce(
			(sum, tableName) => sum + (data[tableName]?.length ?? 0),
			0
		)
	}));

	return {
		sectionOrder: SECTION_ORDER,
		sections,
		totalTables: TABLES.length,
		totalRows: Object.values(data).reduce((sum, rows) => sum + rows.length, 0),
		supportsRestoreModes: ['apply']
	};
}

export class ConfigurationBackupService {
	private async readTableRows(config: TableBackupConfig): Promise<Record<string, unknown>[]> {
		return (await db.select().from(config.table)) as Record<string, unknown>[];
	}

	async exportConfig(
		passphrase: string,
		options: ExportConfigOptions = {}
	): Promise<ConfigurationBackupFile> {
		const data: Record<string, unknown[]> = {};
		const secretPayload: BackupSecretPayload = {
			tables: {}
		};

		for (const config of TABLES) {
			let rows: Record<string, unknown>[];
			try {
				rows = await this.readTableRows(config);
			} catch (error) {
				if (config.name === 'downloadClients') {
					logger.error(
						{
							table: config.name,
							component: 'ConfigurationBackupService',
							logDomain: 'system'
						},
						'Configuration backup failed while reading required table'
					);
					throw new ValidationError(`Configuration backup failed while reading ${config.name}`);
				}
				// Table may not exist (e.g. dropped by a migration but still in the
				// schema definition). Skip it gracefully.
				logger.debug(
					{
						err: error,
						table: config.name,
						component: 'ConfigurationBackupService',
						logDomain: 'system'
					},
					'Skipping table during backup export (table may not exist)'
				);
				data[config.name] = [];
				continue;
			}
			const sanitizedRows: Record<string, unknown>[] = [];
			const tableSecrets: Record<string, unknown> = {};

			for (const row of rows) {
				const recordKey = config.getRecordKey(row);

				if (isKeyValueSecretEntry(config.name, row)) {
					sanitizedRows.push({ ...row, value: null });
					tableSecrets[recordKey] = { value: row.value };
					continue;
				}

				const extracted = extractSecrets(row);
				sanitizedRows.push(extracted.sanitized as Record<string, unknown>);
				if (extracted.secret !== undefined) {
					tableSecrets[recordKey] = extracted.secret;
				}

				// Debrid token portable transform: decrypt the at-rest encrypted
				// token and store the plaintext in the backup secrets payload so
				// it can be re-encrypted with a different master key on restore.
				// If decryption fails, fail the backup closed rather than silently
				// dropping the credential.
				if (config.name === 'downloadClients' && row.apiToken) {
					const stored = row.apiToken as string;
					const plaintext = isEncryptedCredential(stored)
						? decryptCredential('debrid-token', String(recordKey), stored)
						: decryptDebridToken(stored);
					if (plaintext === null) {
						throw new ValidationError(
							`Failed to decrypt debrid token for client ${recordKey}; backup aborted`
						);
					}
					const existingSecret = (tableSecrets[recordKey] as Record<string, unknown>) ?? {};
					existingSecret.apiToken = plaintext;
					existingSecret.apiTokenPlaintext = true;
					tableSecrets[recordKey] = existingSecret;
				}

				// Media-browser key portable transform: same contract as the debrid
				// token — the backup secrets payload carries plaintext (fail-closed
				// on decrypt error) and restore re-encrypts with the destination
				// master key.
				if (config.name === 'mediaBrowserServers' && row.apiKey) {
					const stored = row.apiKey as string;
					const legacyTriplet =
						stored.split(':').length === 3 &&
						stored.split(':').every((p) => /^[0-9a-f]+$/i.test(p));
					const plaintext = isEncryptedCredential(stored)
						? decryptCredential('media-browser-api-key', String(recordKey), stored)
						: legacyTriplet
							? decryptApiKey(stored)
							: stored;
					if (plaintext === null) {
						throw new ValidationError(
							`Failed to decrypt media browser API key for server ${recordKey}; backup aborted`
						);
					}
					const existingSecret = (tableSecrets[recordKey] as Record<string, unknown>) ?? {};
					existingSecret.apiKey = plaintext;
					existingSecret.apiKeyPlaintext = true;
					tableSecrets[recordKey] = existingSecret;
				}

				// Registry-covered tables: every credential envelope in the
				// secrets tree becomes plaintext in the portable payload.
				const spec = findSecretFieldSpecByAlias(config.name);
				if (spec && tableSecrets[recordKey] !== undefined) {
					tableSecrets[recordKey] = decryptBackupSecretTree(
						spec.purpose,
						String(recordKey),
						tableSecrets[recordKey]
					);
				}
			}

			data[config.name] = sanitizedRows;
			if (Object.keys(tableSecrets).length > 0) {
				secretPayload.tables[config.name] = tableSecrets;
			}
		}

		if (options.includeIndexerCookies) {
			const cookieRows = await db
				.select({
					indexerId: indexerStatus.indexerId,
					cookies: indexerStatus.cookies,
					cookiesExpirationDate: indexerStatus.cookiesExpirationDate
				})
				.from(indexerStatus);

			const activeCookieRows = cookieRows.filter(
				(row) =>
					!!row.cookies &&
					!!row.cookiesExpirationDate &&
					new Date(row.cookiesExpirationDate).getTime() > Date.now()
			);

			if (activeCookieRows.length > 0) {
				secretPayload.indexerCookies = Object.fromEntries(
					activeCookieRows
						.map((row) => {
							// Cookies are an envelope at rest; the backup carries the
							// plaintext map so restore works across master keys.
							const stored = row.cookies;
							let cookies: Record<string, string> | null;
							if (typeof stored === 'string' && isEncryptedCredential(stored)) {
								const plaintext = decryptCredential(
									'indexer-cookies',
									row.indexerId,
									stored,
									`backup:indexer-cookies:${row.indexerId}`
								);
								cookies = plaintext ? (JSON.parse(plaintext) as Record<string, string>) : null;
							} else {
								cookies = stored as Record<string, string> | null;
							}
							return [
								row.indexerId,
								{
									cookies,
									expiry: row.cookiesExpirationDate as string
								}
							];
						})
						.filter((entry) => (entry[1] as { cookies: unknown }).cookies !== null)
				);
			}
		}

		return {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			createdAt: new Date().toISOString(),
			manifest: buildManifest(data),
			options: {
				includeIndexerCookies: !!options.includeIndexerCookies
			},
			data,
			secrets: encryptBackupPayload(secretPayload as unknown as Record<string, unknown>, passphrase)
		};
	}

	async restoreConfig(
		backup: ConfigurationBackupFile,
		options: RestoreConfigOptions
	): Promise<RestoreConfigResult> {
		this.validateBackupFile(backup);

		const mode = options.mode ?? 'apply';
		if (mode !== 'apply') {
			throw new ValidationError(
				'Replace-all restore mode is not implemented yet. Use apply mode to avoid breaking existing references.'
			);
		}

		const selectedSections =
			options.sections && options.sections.length > 0
				? new Set(options.sections)
				: new Set<BackupSectionName>(SECTION_ORDER);
		const selectedTableNames = new Set<TableName>(
			SECTIONS.filter((section) => selectedSections.has(section.id)).flatMap(
				(section) => section.tableNames
			)
		);
		if (selectedSections.has('downloads')) selectedTableNames.add('settings');
		const warnings: string[] = [];
		let decryptedSecrets: BackupSecretPayload;
		try {
			decryptedSecrets = decryptBackupPayload(
				backup.secrets,
				options.passphrase
			) as unknown as BackupSecretPayload;
		} catch (error) {
			logger.error(
				{ err: error, component: 'ConfigurationBackupService', logDomain: 'system' },
				'Failed to decrypt configuration backup'
			);
			throw new ValidationError('Invalid backup passphrase or corrupted secret payload');
		}

		const preparedTables: PreparedRestoreTable[] = [];
		const restoredTables: TableName[] = [];

		for (const config of IMPORT_ORDER) {
			if (!selectedTableNames.has(config.name)) {
				continue;
			}

			const rawRows =
				config.name === 'settings' &&
				selectedSections.has('downloads') &&
				!selectedSections.has('system')
					? (backup.data[config.name] ?? []).filter(
							(row) => (row as Record<string, unknown>).key === 'default_acquisition_protocol'
						)
					: (backup.data[config.name] ?? []);
			if (!Array.isArray(rawRows) || rawRows.length === 0) {
				continue;
			}

			const tableSecrets =
				(decryptedSecrets.tables?.[config.name] as Record<string, unknown> | undefined) ?? {};
			const existingRows = (await db.select().from(config.table)) as Record<string, unknown>[];
			const existingRowMap = new Map(
				existingRows.map((row) => [config.getRecordKey(row), row] as const)
			);

			const restoredRows = rawRows.map((rawRow) => {
				const row = rawRow as Record<string, unknown>;
				const recordKey = config.getRecordKey(row);
				const restoredWithSecrets = deepMergeRecord(row, tableSecrets[recordKey]);
				const restored = deserializeRestoredRow(
					config.table,
					restoreExistingSensitiveValues(restoredWithSecrets, existingRowMap.get(recordKey))
				);

				// Debrid token portable transform: re-encrypt the plaintext token
				// from the backup secrets with the destination auth secret before
				// writing to the DB. We use explicit metadata in the backup secrets
				// payload (apiTokenPlaintext: true) to decide. If that flag is absent
				// and the value looks like ciphertext, preserve it as-is; otherwise
				// treat it as plaintext and re-encrypt it.
				if (config.name === 'downloadClients') {
					const restoredRecord = restored as Record<string, unknown>;
					const secretEntry = tableSecrets[recordKey] as Record<string, unknown> | undefined;
					if (typeof restoredRecord.apiToken === 'string' && restoredRecord.apiToken.length > 0) {
						const isPlaintextFromSecrets = secretEntry?.apiTokenPlaintext === true;
						if (isPlaintextFromSecrets) {
							restoredRecord.apiToken = encryptCredential(
								'debrid-token',
								String(recordKey),
								restoredRecord.apiToken
							);
						} else {
							const parts = restoredRecord.apiToken.split(':');
							const looksLegacyEncrypted =
								parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
							if (!looksLegacyEncrypted && !isEncryptedCredential(restoredRecord.apiToken)) {
								restoredRecord.apiToken = encryptCredential(
									'debrid-token',
									String(recordKey),
									restoredRecord.apiToken
								);
							}
						}
					}
				}

				if (config.name === 'mediaBrowserServers') {
					const restoredRecord = restored as Record<string, unknown>;
					const secretEntry = tableSecrets[recordKey] as Record<string, unknown> | undefined;
					if (typeof restoredRecord.apiKey === 'string' && restoredRecord.apiKey.length > 0) {
						const isPlaintextFromSecrets = secretEntry?.apiKeyPlaintext === true;
						if (isPlaintextFromSecrets) {
							restoredRecord.apiKey = encryptCredential(
								'media-browser-api-key',
								String(recordKey),
								restoredRecord.apiKey
							);
						} else {
							const parts = restoredRecord.apiKey.split(':');
							const looksLegacyEncrypted =
								parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
							if (!looksLegacyEncrypted && !isEncryptedCredential(restoredRecord.apiKey)) {
								restoredRecord.apiKey = encryptCredential(
									'media-browser-api-key',
									String(recordKey),
									restoredRecord.apiKey
								);
							}
						}
					}
				}

				// Registry-covered tables: re-encrypt the restored plaintext
				// secrets with the destination master key (idempotent — values
				// that are already envelopes pass through).
				const spec = findSecretFieldSpecByAlias(config.name);
				if (spec) {
					encryptRecordSecrets(spec, restored as Record<string, unknown>);
				}

				return restored;
			});

			preparedTables.push({
				config,
				rows: restoredRows
			});
			restoredTables.push(config.name);
		}

		db.transaction((tx) => {
			for (const preparedTable of preparedTables) {
				for (const restoredRow of preparedTable.rows) {
					tx.insert(preparedTable.config.table)
						.values(restoredRow as never)
						.onConflictDoUpdate({
							target: preparedTable.config.conflictTarget,
							set: restoredRow as never
						})
						.run();
				}
			}
		});

		if (restoredTables.includes('namingSettings')) {
			// Rows were written directly to the DB, bypassing NamingSettingsService.
			// Drop both its config cache and the rename-preview cache so naming
			// previews reflect the restored formats.
			namingSettingsService.invalidateCache();
			const { renamePreviewCache } =
				await import('#lib/server/library/naming/RenamePreviewCache.js');
			renamePreviewCache.invalidateAll();
		}

		if (selectedSections.has('indexers') && decryptedSecrets.indexerCookies) {
			const cookieStore = getCookieStore();
			for (const [indexerId, stored] of Object.entries(decryptedSecrets.indexerCookies)) {
				await cookieStore.clear(indexerId);
				await cookieStore.save(indexerId, stored.cookies, new Date(stored.expiry));
			}
		}

		return {
			restoredSections: SECTION_ORDER.filter((section) => selectedSections.has(section)),
			restoredTables,
			secretsRestored: true,
			warnings: [...new Set(warnings)]
		};
	}

	private validateBackupFile(backup: ConfigurationBackupFile): void {
		if (backup.format !== BACKUP_FORMAT) {
			throw new ValidationError('Unsupported backup format');
		}

		if (backup.version !== BACKUP_VERSION) {
			throw new ValidationError(`Unsupported backup version: ${backup.version}`);
		}

		if (!backup.data || typeof backup.data !== 'object') {
			throw new ValidationError('Backup file is missing configuration data');
		}
	}
}

let _instance: ConfigurationBackupService | null = null;

export function getConfigurationBackupService(): ConfigurationBackupService {
	if (!_instance) {
		_instance = new ConfigurationBackupService();
	}
	return _instance;
}

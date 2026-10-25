import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Migration definition with metadata for tracking
 */
export interface MigrationDefinition {
	version: number;
	name: string;
	apply: (sqlite: Database.Database) => void;
}

export const BETTER_AUTH_TABLE_DEFINITIONS = [
	{
		name: 'user',
		sql: `CREATE TABLE IF NOT EXISTS "user" (
			"id" text PRIMARY KEY NOT NULL,
			"name" text,
			"email" text NOT NULL,
			"emailVerified" integer DEFAULT 0,
			"image" text,
			"username" text UNIQUE,
			"displayUsername" text,
			"role" text DEFAULT 'user' NOT NULL,
			"language" text DEFAULT 'en',
			"banned" integer DEFAULT 0,
			"banReason" text,
			"banExpires" date,
			"createdAt" date NOT NULL,
			"updatedAt" date NOT NULL,
			"lastActiveAt" date
		)`
	},
	{
		name: 'session',
		sql: `CREATE TABLE IF NOT EXISTS "session" (
			"id" text PRIMARY KEY NOT NULL,
			"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
			"token" text NOT NULL UNIQUE,
			"expiresAt" date NOT NULL,
			"ipAddress" text,
			"userAgent" text,
			"impersonatedBy" text,
			"createdAt" date NOT NULL,
			"updatedAt" date NOT NULL,
			"lastActiveAt" date
		)`
	},
	{
		name: 'account',
		sql: `CREATE TABLE IF NOT EXISTS "account" (
			"id" text PRIMARY KEY NOT NULL,
			"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
			"accountId" text NOT NULL,
			"providerId" text NOT NULL,
			"accessToken" text,
			"refreshToken" text,
			"accessTokenExpiresAt" date,
			"refreshTokenExpiresAt" date,
			"scope" text,
			"idToken" text,
			"password" text,
			"createdAt" date NOT NULL,
			"updatedAt" date NOT NULL
		)`
	},
	{
		name: 'verification',
		sql: `CREATE TABLE IF NOT EXISTS "verification" (
			"id" text PRIMARY KEY NOT NULL,
			"identifier" text NOT NULL,
			"value" text NOT NULL,
			"expiresAt" date NOT NULL,
			"createdAt" date,
			"updatedAt" date
		)`
	},
	{
		name: 'apikey',
		sql: `CREATE TABLE IF NOT EXISTS "apikey" (
			"id" text PRIMARY KEY NOT NULL,
			"name" text,
			"start" text,
			"prefix" text,
			"key" text NOT NULL,
			"referenceId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
			"configId" text DEFAULT 'default',
			"refillInterval" integer,
			"refillAmount" integer,
			"lastRefillAt" date,
			"enabled" integer DEFAULT 1,
			"rateLimitEnabled" integer DEFAULT 1,
			"rateLimitTimeWindow" integer,
			"rateLimitMax" integer,
			"requestCount" integer DEFAULT 0,
			"remaining" integer,
			"lastRequest" date,
			"expiresAt" date,
			"createdAt" date NOT NULL,
			"updatedAt" date NOT NULL,
			"permissions" text,
			"metadata" text
		)`
	},
	{
		name: 'rateLimit',
		sql: `CREATE TABLE IF NOT EXISTS "rateLimit" (
			"id" text PRIMARY KEY NOT NULL,
			"key" text NOT NULL UNIQUE,
			"count" integer NOT NULL,
			"lastRequest" integer NOT NULL
		)`
	}
] as const;

export const BETTER_AUTH_INDEX_DEFINITIONS = [
	{
		name: 'idx_session_user',
		table: 'session',
		columns: ['userId'],
		sql: `CREATE INDEX IF NOT EXISTS "idx_session_user" ON "session" ("userId")`
	},
	{
		name: 'idx_account_user',
		table: 'account',
		columns: ['userId'],
		sql: `CREATE INDEX IF NOT EXISTS "idx_account_user" ON "account" ("userId")`
	},
	{
		name: 'idx_account_provider',
		table: 'account',
		columns: ['providerId', 'accountId'],
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_provider" ON "account" ("providerId", "accountId")`
	},
	{
		name: 'idx_user_email',
		table: 'user',
		columns: ['email'],
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_email" ON "user" ("email")`
	},
	{
		name: 'idx_user_username',
		table: 'user',
		columns: ['username'],
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_username" ON "user" ("username")`
	},
	{
		name: 'idx_apikey_key',
		table: 'apikey',
		columns: ['key'],
		sql: `CREATE INDEX IF NOT EXISTS "idx_apikey_key" ON "apikey" ("key")`
	},
	{
		name: 'idx_rateLimit_key',
		table: 'rateLimit',
		columns: ['key'],
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS "idx_rateLimit_key" ON "rateLimit" ("key")`
	}
] as const;

/**
 * All table definitions with CREATE TABLE IF NOT EXISTS
 * Order matters for foreign key constraints
 */

export function getSchemaVersion(sqlite: Database.Database): number {
	try {
		const result = sqlite
			.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`)
			.get() as { value: string } | undefined;
		return result ? parseInt(result.value, 10) : 0;
	} catch {
		// Table doesn't exist yet
		return 0;
	}
}

/**
 * Set schema version in database
 */
export function setSchemaVersion(sqlite: Database.Database, version: number): void {
	sqlite
		.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)`)
		.run(version.toString());
}

/**
 * Check if a table exists in the database
 */
export function tableExists(sqlite: Database.Database, tableName: string): boolean {
	const result = sqlite
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!result;
}

/**
 * Check if a column exists in a table
 */
export function columnExists(
	sqlite: Database.Database,
	tableName: string,
	columnName: string
): boolean {
	const result = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
	return result.some((col) => col.name === columnName);
}

export function renameColumnIfExists(
	sqlite: Database.Database,
	tableName: string,
	fromColumn: string,
	toColumn: string
): void {
	if (
		!tableExists(sqlite, tableName) ||
		columnExists(sqlite, tableName, toColumn) ||
		!columnExists(sqlite, tableName, fromColumn)
	) {
		return;
	}

	try {
		sqlite
			.prepare(`ALTER TABLE "${tableName}" RENAME COLUMN "${fromColumn}" TO "${toColumn}"`)
			.run();
		logger.info(`[SchemaSync] Renamed ${tableName}.${fromColumn} to ${toColumn}`);
	} catch (error) {
		logger.warn(
			{
				table: tableName,
				from: fromColumn,
				to: toColumn,
				error: error instanceof Error ? error.message : String(error)
			},
			'[SchemaSync] Failed to rename legacy column'
		);
	}
}

export function ensureColumn(
	sqlite: Database.Database,
	tableName: string,
	columnName: string,
	columnDefinition: string
): void {
	if (!tableExists(sqlite, tableName) || columnExists(sqlite, tableName, columnName)) {
		return;
	}

	sqlite.prepare(`ALTER TABLE "${tableName}" ADD COLUMN ${columnDefinition}`).run();
	logger.info(`[SchemaSync] Added ${tableName}.${columnName}`);
}

export function getTableRowCount(sqlite: Database.Database, tableName: string): number {
	if (!tableExists(sqlite, tableName)) {
		return 0;
	}

	const result = sqlite.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as {
		count: number;
	};
	return result.count;
}

export function createBetterAuthTables(sqlite: Database.Database): void {
	for (const { sql } of BETTER_AUTH_TABLE_DEFINITIONS) {
		sqlite.prepare(sql).run();
	}
}

export function createBetterAuthIndexes(sqlite: Database.Database): void {
	for (const indexDef of BETTER_AUTH_INDEX_DEFINITIONS) {
		if (!tableExists(sqlite, indexDef.table)) {
			continue;
		}

		const missingColumns = indexDef.columns.filter(
			(columnName) => !columnExists(sqlite, indexDef.table, columnName)
		);
		if (missingColumns.length > 0) {
			logger.warn(
				{
					index: indexDef.name,
					table: indexDef.table,
					missingColumns
				},
				'[SchemaSync] Skipping Better Auth index, missing columns'
			);
			continue;
		}

		sqlite.prepare(indexDef.sql).run();
	}

	if (!tableExists(sqlite, 'apikey')) {
		return;
	}

	const columns = sqlite.prepare(`PRAGMA table_info(apikey)`).all() as Array<{ name: string }>;
	const hasReferenceId = columns.some((col) => col.name === 'referenceId');
	const hasUserId = columns.some((col) => col.name === 'userId');

	if (hasReferenceId) {
		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_apikey_reference" ON "apikey" ("referenceId")`)
			.run();
		return;
	}

	if (hasUserId) {
		sqlite.prepare(`CREATE INDEX IF NOT EXISTS "idx_apikey_user" ON "apikey" ("userId")`).run();
	}
}

/**
 * Converge the apikey table to the v1.5+ shape (referenceId + configId).
 * Runs at auth module init, before betterAuth() is constructed: better-auth
 * >= 1.7 validates the schema on first access and latches a mismatch for the
 * process lifetime, so a pre-1.5 database must be converged before the first
 * auth request — it cannot wait for schema-sync migrations 065/066.
 */
export function convergeApikeySchemaToV15(sqlite: Database.Database): void {
	if (!tableExists(sqlite, 'apikey')) {
		return;
	}

	renameColumnIfExists(sqlite, 'apikey', 'userId', 'referenceId');
	ensureColumn(sqlite, 'apikey', 'configId', `"configId" text DEFAULT 'default'`);
}

export function recreateBetterAuthSchema(sqlite: Database.Database): void {
	const dropOrder = ['apikey', 'account', 'session', 'verification', 'rateLimit', 'user'];

	for (const tableName of dropOrder) {
		if (tableExists(sqlite, tableName)) {
			sqlite.prepare(`DROP TABLE "${tableName}"`).run();
		}
	}

	createBetterAuthTables(sqlite);
	createBetterAuthIndexes(sqlite);
}

/**
 * Check if database has legacy Live TV schema from before the rewrite.
 * This detects databases that need cleanup before migrations can run safely.
 *
 * Legacy indicators:
 * - stalker_portal_accounts: Old table structure (v11-16 GitHub version)
 * - epg_sources: Old XMLTV-based EPG system
 * - livetv_channels_cache: Intermediate external API system (v14-21)
 */
export function hasLegacyLiveTvSchema(sqlite: Database.Database): boolean {
	return (
		tableExists(sqlite, 'stalker_portal_accounts') ||
		tableExists(sqlite, 'epg_sources') ||
		tableExists(sqlite, 'livetv_channels_cache')
	);
}

/**
 * Clean up all Live TV related tables (legacy and current).
 * This is used when migrating from incompatible schema versions.
 * Tables will be recreated fresh from TABLE_DEFINITIONS.
 */
export function cleanupLiveTvTables(sqlite: Database.Database): void {
	const liveTvTables = [
		// Old v11-16 GitHub tables
		'stalker_portal_accounts',
		'epg_sources',
		'live_events',
		// Intermediate v14-21 external API tables
		'livetv_channels_cache',
		'livetv_categories',
		'livetv_lineup',
		'livetv_events_cache',
		'livetv_settings',
		'livetv_stream_health',
		'livetv_epg_sources',
		'livetv_epg_channel_map',
		'livetv_epg_programs',
		'livetv_epg_cache',
		// Current v23-28 tables (will be recreated from TABLE_DEFINITIONS)
		'channel_lineup_backups',
		'epg_programs',
		'channel_lineup_items',
		'channel_categories',
		'stalker_channels',
		'stalker_categories',
		'stalker_accounts',
		// Old settings table
		'live_tv_settings'
	];

	// Drop in reverse dependency order (children before parents)
	for (const table of liveTvTables) {
		if (tableExists(sqlite, table)) {
			sqlite.prepare(`DROP TABLE "${table}"`).run();
			logger.info(`[SchemaSync] Dropped legacy Live TV table: ${table}`);
		}
	}

	// Clean up orphaned indexes that might reference old tables
	const orphanedIndexes = [
		'idx_stalker_accounts_priority',
		'idx_epg_sources_enabled',
		'idx_epg_sources_priority',
		'idx_livetv_cache_country',
		'idx_livetv_cache_status',
		'idx_livetv_categories_position',
		'idx_livetv_lineup_position',
		'idx_livetv_lineup_category',
		'idx_livetv_lineup_channel',
		'idx_livetv_events_sport',
		'idx_livetv_events_status',
		'idx_livetv_events_time',
		'idx_livetv_health_status',
		'idx_livetv_epg_sources_enabled',
		'idx_livetv_epg_channel_map_source',
		'idx_livetv_epg_channel_map_channel',
		'idx_livetv_epg_programs_channel',
		'idx_livetv_epg_programs_source',
		'idx_livetv_epg_programs_time',
		'idx_livetv_epg_source_name',
		'idx_livetv_epg_xmltv_lookup'
	];

	for (const index of orphanedIndexes) {
		try {
			sqlite.prepare(`DROP INDEX IF EXISTS "${index}"`).run();
		} catch {
			// Index might not exist, that's fine
		}
	}
}

/**
 * Critical columns that must exist for the app to function.
 * Used to verify schema integrity after migrations.
 */
export const CRITICAL_TABLES = [
	'user',
	'session',
	'account',
	'verification',
	'apikey',
	'rateLimit'
];

export const CRITICAL_COLUMNS: Record<string, string[]> = {
	user: ['id', 'email', 'username', 'displayUsername', 'role', 'banned', 'createdAt', 'updatedAt'],
	session: ['id', 'userId', 'token', 'expiresAt', 'impersonatedBy', 'createdAt', 'updatedAt'],
	account: ['id', 'userId', 'accountId', 'providerId', 'createdAt', 'updatedAt'],
	verification: ['id', 'identifier', 'value', 'expiresAt'],
	apikey: ['id', 'key', 'referenceId', 'createdAt', 'updatedAt'],
	rateLimit: ['id', 'key', 'count', 'lastRequest'],
	download_clients: [
		'id',
		'name',
		'implementation',
		'host',
		'port',
		'url_base',
		'mount_mode',
		'health',
		'consecutive_failures'
	],
	root_folders: ['id', 'path', 'media_sub_type', 'read_only', 'preserve_symlinks'],
	libraries: [
		'id',
		'name',
		'slug',
		'media_type',
		'media_sub_type',
		'is_system',
		'language_profile_id'
	],
	movies: [
		'id',
		'tmdb_id',
		'title',
		'path',
		'monitored',
		'library_id',
		'original_language',
		'metadata_language_mode',
		'metadata_language_value',
		'subtitle_requirements_override'
	],
	series: [
		'id',
		'tmdb_id',
		'title',
		'path',
		'monitored',
		'library_id',
		'original_language',
		'metadata_language_mode',
		'metadata_language_value',
		'subtitle_requirements_override'
	],
	episodes: [
		'id',
		'series_id',
		'season_number',
		'episode_number',
		'subtitle_requirements_override'
	],
	subtitles: ['id', 'relative_path', 'language', 'format', 'last_checked_at'],
	indexers: ['id', 'name', 'definition_id', 'enabled'],
	scoring_profiles: ['id', 'name', 'is_default']
};

/**
 * Compute a checksum for a migration (used for tracking changes)
 */
export function computeMigrationChecksum(migration: MigrationDefinition): string {
	const content = `${migration.version}:${migration.name}:${migration.apply.toString()}`;
	return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Get all applied migrations from the schema_migrations table
 */
export function getAppliedMigrations(
	sqlite: Database.Database
): Map<number, { checksum: string; success: number }> {
	const applied = new Map<number, { checksum: string; success: number }>();
	if (!tableExists(sqlite, 'schema_migrations')) return applied;

	const rows = sqlite
		.prepare(`SELECT version, checksum, success FROM schema_migrations`)
		.all() as Array<{ version: number; checksum: string; success: number }>;
	for (const row of rows) {
		applied.set(row.version, { checksum: row.checksum, success: row.success });
	}
	return applied;
}

/**
 * Backfill migration records for existing databases that were using the legacy schema_version system.
 * This ensures backward compatibility when upgrading from the old single-version tracking.
 *
 * Parameterized (instead of importing MIGRATIONS directly) to avoid a static import cycle:
 * migration-helpers -> migrations/index -> migration 064 -> admin-bootstrap -> db/index -> schema-sync -> migration-helpers.
 */
export function backfillMigrationRecords(
	sqlite: Database.Database,
	migrations: MigrationDefinition[]
): void {
	const legacyVersion = getSchemaVersion(sqlite);
	if (legacyVersion === 0) return;

	// Check if we already have migration records
	const existingRecords = sqlite
		.prepare(`SELECT COUNT(*) as count FROM schema_migrations`)
		.get() as { count: number };
	if (existingRecords.count > 0) return;

	logger.info({ legacyVersion }, '[SchemaSync] Backfilling migration records for legacy database');

	const now = new Date().toISOString();
	const stmt = sqlite.prepare(`
		INSERT OR IGNORE INTO schema_migrations (version, name, checksum, applied_at, execution_time_ms, success)
		VALUES (?, ?, ?, ?, 0, 1)
	`);

	for (const migration of migrations) {
		if (migration.version <= legacyVersion) {
			stmt.run(migration.version, migration.name, computeMigrationChecksum(migration), now);
		}
	}
}

/**
 * Map of migration versions to the columns they should create.
 * Used for drift detection - if a migration is marked as applied but the column doesn't exist,
 * we mark it as failed so it re-runs.
 */
export const MIGRATION_COLUMN_MAP: Record<number, Array<{ table: string; column: string }>> = {
	3: [{ table: 'root_folders', column: 'read_only' }],
	5: [{ table: 'root_folders', column: 'preserve_symlinks' }],
	11: [
		{ table: 'download_clients', column: 'temp_path_local' },
		{ table: 'download_clients', column: 'temp_path_remote' }
	],
	34: [{ table: 'download_clients', column: 'url_base' }],
	35: [{ table: 'download_clients', column: 'mount_mode' }],
	55: [
		{ table: 'download_clients', column: 'health' },
		{ table: 'download_clients', column: 'consecutive_failures' },
		{ table: 'download_clients', column: 'last_success' },
		{ table: 'download_clients', column: 'last_failure' },
		{ table: 'download_clients', column: 'last_failure_message' },
		{ table: 'download_clients', column: 'last_checked_at' }
	],
	63: [
		{ table: 'user', column: 'email' },
		{ table: 'user', column: 'displayUsername' },
		{ table: 'user', column: 'banned' },
		{ table: 'session', column: 'userId' },
		{ table: 'session', column: 'impersonatedBy' },
		{ table: 'account', column: 'userId' },
		{ table: 'account', column: 'accountId' },
		{ table: 'account', column: 'providerId' },
		{ table: 'apikey', column: 'key' },
		{ table: 'rateLimit', column: 'lastRequest' }
	],
	65: [
		{ table: 'apikey', column: 'referenceId' },
		{ table: 'apikey', column: 'configId' }
	],
	67: [{ table: 'rateLimit', column: 'id' }],
	68: [{ table: 'episode_files', column: 'edition' }],
	76: [{ table: 'root_folders', column: 'media_sub_type' }],
	77: [
		{ table: 'libraries', column: 'id' },
		{ table: 'movies', column: 'library_id' },
		{ table: 'series', column: 'library_id' }
	],
	81: [
		{ table: 'scoring_profiles', column: 'is_built_in' },
		{ table: 'scoring_profiles', column: 'min_resolution' },
		{ table: 'scoring_profiles', column: 'max_resolution' },
		{ table: 'scoring_profiles', column: 'allowed_sources' },
		{ table: 'scoring_profiles', column: 'excluded_sources' }
	],
	83: [
		{ table: 'movies', column: 'tmdb_collection_id' },
		{ table: 'movies', column: 'collection_name' }
	],
	84: [
		{ table: 'movies', column: 'release_date' },
		{ table: 'series', column: 'first_air_date' }
	],
	// metadata_provider and pinned_external from v85/v86 are dropped by v95
	85: [{ table: 'series', column: 'provider_refs' }],
	86: [{ table: 'movies', column: 'provider_refs' }],
	88: [
		{ table: 'root_folders', column: 'skip_folder_patterns' },
		{ table: 'root_folders', column: 'blocked_video_extensions' }
	],
	91: [
		{ table: 'movies', column: 'download_release_date' },
		{ table: 'movies', column: 'download_release_type' }
	],
	92: [
		{ table: 'movies', column: 'digital_release_date' },
		{ table: 'movies', column: 'physical_release_date' },
		{ table: 'movies', column: 'availability_delay' }
	],
	93: [{ table: 'indexers', column: 'upstream_enabled' }],
	94: [{ table: 'indexers', column: 'orphaned' }],
	96: [
		{ table: 'movies', column: 'adult' },
		{ table: 'movies', column: 'adult_source' },
		{ table: 'movies', column: 'adult_confidence' },
		{ table: 'series', column: 'adult' },
		{ table: 'series', column: 'adult_source' },
		{ table: 'series', column: 'adult_confidence' }
	],
	97: [{ table: 'series', column: 'episode_group_id' }],
	98: [
		{ table: 'indexers', column: 'cached_categories' },
		{ table: 'indexers', column: 'additional_categories' }
	],
	100: [{ table: 'scoring_profiles', column: 'prevent_downgrades' }],
	102: [{ table: 'indexers', column: 'is_built_in' }],
	105: [
		{ table: 'pending_releases', column: 'publish_date' },
		{ table: 'movies', column: 'delay_profile_id' },
		{ table: 'series', column: 'delay_profile_id' }
	],
	106: [{ table: 'scoring_profiles', column: 'required_formats' }],
	108: [{ table: 'download_queue', column: 'stalled_since' }],
	125: [
		{ table: 'download_clients', column: 'api_token' },
		{ table: 'download_clients', column: 'remove_after_import' }
	],
	132: [{ table: 'download_clients', column: 'sequential_download' }],
	133: [{ table: 'download_queue', column: 'import_failed' }],
	137: [
		{ table: 'download_clients', column: 'allow_movies' },
		{ table: 'download_clients', column: 'allow_tv' }
	],
	140: [
		{ table: 'movies', column: 'original_language' },
		{ table: 'movies', column: 'metadata_language_mode' },
		{ table: 'movies', column: 'metadata_language_value' },
		{ table: 'series', column: 'original_language' },
		{ table: 'series', column: 'metadata_language_mode' },
		{ table: 'series', column: 'metadata_language_value' },
		{ table: 'libraries', column: 'language_profile_id' }
	],
	141: [{ table: 'subtitles', column: 'last_checked_at' }],
	143: [
		{ table: 'media_server_synced_items', column: 'audio_languages_raw' },
		{ table: 'media_server_synced_items', column: 'subtitle_languages_raw' },
		{ table: 'epg_programs', column: 'title_i18n' },
		{ table: 'epg_programs', column: 'description_i18n' },
		{ table: 'epg_programs', column: 'category_i18n' }
	],
	144: [{ table: 'language_settings', column: 'prefer_original_title' }],
	146: [
		{ table: 'movies', column: 'subtitle_requirements_override' },
		{ table: 'series', column: 'subtitle_requirements_override' },
		{ table: 'episodes', column: 'subtitle_requirements_override' }
	],
	147: [
		{ table: 'movies', column: 'language_shortfall' },
		{ table: 'series', column: 'language_shortfall' }
	],
	151: [
		{ table: 'episodes', column: 'wants_subtitles_override' },
		{ table: 'movies', column: 'language_profile_id' },
		{ table: 'series', column: 'language_profile_id' },
		{ table: 'smart_lists', column: 'language_profile_id' }
	],
	154: [{ table: 'library_jobs', column: 'acknowledged_at' }],
	155: [{ table: 'indexers', column: 'rate_limit_per_minute' }],
	156: [{ table: 'indexer_status', column: 'disabled_reason' }]
};

/**
 * Detect schema drift and mark affected migrations for re-run.
 * This handles the case where schema_version says X but columns from migration X are missing.
 */
export function detectAndFixSchemaDrift(sqlite: Database.Database): void {
	let driftFound = false;

	for (const [versionStr, columns] of Object.entries(MIGRATION_COLUMN_MAP)) {
		const version = parseInt(versionStr, 10);

		for (const { table, column } of columns) {
			if (tableExists(sqlite, table) && !columnExists(sqlite, table, column)) {
				// Column should exist but doesn't - mark this migration AND every
				// migration after it as failed so they re-run in order. Re-running
				// only the failed version can leave a later migration's columns
				// dropped (e.g. a table-rebuild migration) with no repair path.
				logger.warn(
					`[SchemaSync] Schema drift detected: ${table}.${column} missing (migration v${version})`
				);
				sqlite.prepare(`UPDATE schema_migrations SET success = 0 WHERE version >= ?`).run(version);
				driftFound = true;
			}
		}
	}

	if (driftFound) {
		logger.info('[SchemaSync] Schema drift detected and migrations marked for re-run');
	}
}

/**
 * Verify schema integrity by checking that critical columns exist.
 * Throws an error if any critical columns are missing.
 */
export function verifySchemaIntegrity(sqlite: Database.Database): void {
	const issues: string[] = [];

	for (const table of CRITICAL_TABLES) {
		if (!tableExists(sqlite, table)) {
			issues.push(`Missing table: ${table}`);
		}
	}

	for (const [table, columns] of Object.entries(CRITICAL_COLUMNS)) {
		if (!tableExists(sqlite, table)) {
			continue;
		}

		for (const column of columns) {
			if (!columnExists(sqlite, table, column)) {
				issues.push(`Missing column: ${table}.${column}`);
			}
		}
	}

	if (issues.length > 0) {
		logger.error({ issues }, '[SchemaSync] Schema integrity check failed');
		throw new Error(`Schema integrity check failed: ${issues.join(', ')}`);
	}
}

/**
 * Apply a single migration with transaction wrapping and tracking
 */
export function applyMigration(sqlite: Database.Database, migration: MigrationDefinition): void {
	const checksum = computeMigrationChecksum(migration);
	const startTime = Date.now();

	logger.info(`[SchemaSync] Applying migration v${migration.version}: ${migration.name}`);

	// Migrations perform schema surgery (table rebuilds, drops) that must not fire
	// FK actions — e.g. dropping a parent table while children reference it would
	// otherwise cascade-delete child rows. PRAGMA foreign_keys is a no-op inside a
	// transaction, so it is toggled here, before the migration transaction opens,
	// and restored afterwards.
	const foreignKeysWereOn = sqlite.pragma('foreign_keys', { simple: true }) === 1;
	if (foreignKeysWereOn) sqlite.pragma('foreign_keys = OFF');

	try {
		// Mark as in-progress (success=0)
		sqlite
			.prepare(
				`
		INSERT OR REPLACE INTO schema_migrations (version, name, checksum, applied_at, success)
		VALUES (?, ?, ?, ?, 0)
	`
			)
			.run(migration.version, migration.name, checksum, new Date().toISOString());

		// Run migration in a transaction
		sqlite.transaction(() => {
			migration.apply(sqlite);
		})();

		const executionTime = Date.now() - startTime;

		// Mark as successful
		sqlite
			.prepare(`UPDATE schema_migrations SET success = 1, execution_time_ms = ? WHERE version = ?`)
			.run(executionTime, migration.version);

		logger.info(`[SchemaSync] Migration v${migration.version} completed in ${executionTime}ms`);
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error)
			},
			`[SchemaSync] Migration v${migration.version} failed`
		);
		throw error;
	} finally {
		if (foreignKeysWereOn) sqlite.pragma('foreign_keys = ON');
	}
}

/**
 * Synchronize database schema using per-migration tracking.
 *
 * This approach provides:
 * - Individual tracking of each migration
 * - Automatic retry of failed migrations on restart
 * - Backward compatibility with legacy schema_version
 * - Schema integrity verification
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import { syncSchema } from './schema-sync';
import { tableExists, getAppliedMigrations, getSchemaVersion } from './migration-helpers';
import { MIGRATIONS } from './migrations/index';
import { getSharedSqliteConnection } from './connection';

// Single shared connection (see connection.ts) — Better Auth and Drizzle
// both use this handle.
const sqlite = getSharedSqliteConnection();

export const db = drizzle(sqlite, { schema });

// Export sqlite for direct access when needed (schema sync uses it)
export { sqlite };

let initialized = false;

/**
 * Initialize database using embedded schema synchronization.
 *
 * This replaces the previous migration-file-based system with an embedded
 * schema versioning approach (similar to Radarr/Sonarr).
 *
 * Handles:
 * 1. Fresh install - Creates all tables, sets schema version
 * 2. Existing database - Ensures all tables exist, runs incremental updates
 * 3. Migration-era database - Backward compatible with old migration system
 */
function runStartupMaintenance(): void {
	// Maintenance must never brick boot: on constrained deployments a VACUUM
	// can fail (OOM kill mid-write, pre-existing corruption) and a thrown
	// error here previously left the whole app unstartable with no recovery
	// path short of hand-editing the data directory (#513).
	try {
		runVacuumMaintenance();
	} catch (err) {
		logger.error(
			{
				err: err instanceof Error ? err : new Error(String(err))
			},
			'[DB] Startup maintenance failed; continuing without it. ' +
				'If errors persist, restore from Settings > System > Database Backups.'
		);
	}
}

function runVacuumMaintenance(): void {
	// One-time: switch from auto_vacuum=NONE to INCREMENTAL so deleted pages are
	// reclaimed incrementally instead of building up as freelist bloat.
	// PRAGMA auto_vacuum can only change outside a transaction and requires VACUUM
	// to take effect — the pragma value itself (2 = INCREMENTAL) is the done-marker.
	const autoVacuumMode = sqlite.pragma('auto_vacuum', { simple: true }) as number;

	if (autoVacuumMode !== 2) {
		logger.info(
			'[DB] Running one-time VACUUM to reclaim freelist space and enable incremental auto-vacuum (this may take a moment)...'
		);
		const start = Date.now();
		sqlite.pragma('auto_vacuum = INCREMENTAL');
		sqlite.exec('VACUUM');
		logger.info({ durationMs: Date.now() - start }, '[DB] VACUUM complete');
		return;
	}

	// Every startup: reclaim any pages freed since last run.
	sqlite.pragma('incremental_vacuum');
}

export async function initializeDatabase(): Promise<void> {
	if (initialized) return;

	try {
		logger.info('Initializing database...');

		// Pre-update backup: if pending migrations exist, snapshot the DB before applying them.
		// Only triggered on existing installs (schema_migrations table present) with new migrations.
		const hasMigrationsTable = tableExists(sqlite, 'schema_migrations');
		if (hasMigrationsTable) {
			const applied = getAppliedMigrations(sqlite);
			const hasPending = MIGRATIONS.some((m) => {
				const row = applied.get(m.version);
				return !row || row.success === 0;
			});
			if (hasPending) {
				const { dbBackupService } = await import('./DbBackupService.js');
				const schemaVersion = getSchemaVersion(sqlite);
				await dbBackupService.runPreUpdateBackup(sqlite, schemaVersion);
			}
		}

		// Use embedded schema sync (no external migration files needed)
		syncSchema(sqlite);

		runStartupMaintenance();

		const { keywordBlocklistService } =
			await import('#lib/server/settings/KeywordBlocklistService.js');
		await keywordBlocklistService.seedDefaults();

		initialized = true;
		logger.info('Database initialization complete');
	} catch (error) {
		logger.error({ err: error }, 'Database initialization failed');
		throw error;
	}
}

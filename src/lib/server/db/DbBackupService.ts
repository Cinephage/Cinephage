/**
 * Database Backup Service
 *
 * Two backup types:
 *   pre-update  - Always-on. Runs before schema migrations so users can roll back.
 *                 Kept in DATA_DIR/backups/pre-update/, last 5 retained.
 *   scheduled   - User-configurable daily backups.
 *                 Kept in DATA_DIR/backups/scheduled/ (or user-defined path).
 *
 * Both use better-sqlite3's sqlite.backup() which performs a hot, consistent
 * backup that includes WAL frames — safe to run while the app is live.
 */

import Database from 'better-sqlite3';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { resolveAppVersion } from '#lib/server/version.js';

const logger = createChildLogger({ logDomain: 'system' as const });

const DATA_DIR = process.env.DATA_DIR || 'data';
const PRE_UPDATE_DIR = join(DATA_DIR, 'backups', 'pre-update');
const DEFAULT_SCHEDULED_DIR = join(DATA_DIR, 'backups', 'scheduled');
const PRE_UPDATE_KEEP = 5;

const SETTINGS_KEY_ENABLED = 'db_backup.scheduled.enabled';
const SETTINGS_KEY_DIRECTORY = 'db_backup.scheduled.directory';
const SETTINGS_KEY_RETENTION = 'db_backup.scheduled.retention_count';
const DEFAULT_RETENTION = 7;

export interface DbBackupFile {
	filename: string;
	path: string;
	sizeBytes: number;
	createdAt: string;
}

export interface DbBackupSettings {
	enabled: boolean;
	directory: string;
	retentionCount: number;
}

// ---------------------------------------------------------------------------
// Settings helpers (use the `settings` key-value table directly)
// ---------------------------------------------------------------------------

async function getSetting(key: string): Promise<string | null> {
	const row = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, key))
		.get();
	return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
	await db
		.insert(settings)
		.values({ key, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } });
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

async function listBackupFiles(dir: string): Promise<DbBackupFile[]> {
	try {
		const entries = await readdir(dir);
		const dbFiles = entries.filter((f) => f.endsWith('.db')).sort();
		const files: DbBackupFile[] = [];
		for (const filename of dbFiles) {
			const filePath = join(dir, filename);
			try {
				const s = await stat(filePath);
				files.push({
					filename,
					path: filePath,
					sizeBytes: s.size,
					createdAt: s.birthtime.toISOString()
				});
			} catch {
				// skip unreadable files
			}
		}
		return files;
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Collapse WAL into the backup file and remove companion files
// ---------------------------------------------------------------------------

// sqlite.backup() copies the source in WAL mode, so SQLite creates .db-shm
// and .db-wal companions at the destination. Opening the backup and switching
// to DELETE journal mode checkpoints + removes those files, leaving one .db.
function finalizeBackup(backupPath: string): void {
	let finalDb: Database.Database | null = null;
	try {
		finalDb = new Database(backupPath);
		finalDb.pragma('wal_checkpoint(TRUNCATE)');
		finalDb.pragma('journal_mode = DELETE');
	} catch (err) {
		logger.warn({ err, backupPath }, '[DbBackup] Failed to finalize backup (WAL cleanup)');
	} finally {
		finalDb?.close();
	}
}

// ---------------------------------------------------------------------------
// Integrity check on a backup file
// ---------------------------------------------------------------------------

function checkIntegrity(backupPath: string): boolean {
	let testDb: Database.Database | null = null;
	try {
		testDb = new Database(backupPath, { readonly: true });
		const result = testDb.pragma('integrity_check', { simple: true }) as string;
		return result === 'ok';
	} catch (err) {
		logger.warn({ err, backupPath }, '[DbBackup] Integrity check failed');
		return false;
	} finally {
		testDb?.close();
	}
}

// ---------------------------------------------------------------------------
// Rotation: keep the N most recent files; delete the rest
// ---------------------------------------------------------------------------

async function pruneBackups(dir: string, keep: number): Promise<void> {
	const files = await listBackupFiles(dir);

	// Remove excess .db files (oldest first) along with any companion files
	if (files.length > keep) {
		const toDelete = files.slice(0, files.length - keep);
		for (const f of toDelete) {
			for (const suffix of ['', '-shm', '-wal']) {
				const p = f.path + suffix;
				try {
					await unlink(p);
					if (suffix === '') logger.info({ path: p }, '[DbBackup] Pruned old backup');
				} catch {
					// companion may not exist — that's fine
				}
			}
		}
	}

	// Sweep for orphaned companion files whose .db was already removed
	try {
		const entries = await readdir(dir);
		for (const entry of entries) {
			if (!entry.endsWith('.db-shm') && !entry.endsWith('.db-wal')) continue;
			const base = entry.replace(/-(shm|wal)$/, '');
			const dbPath = join(dir, base);
			try {
				await stat(dbPath);
			} catch {
				// .db is gone — remove the orphaned companion
				await unlink(join(dir, entry)).catch(() => {});
			}
		}
	} catch {
		// dir may not exist yet
	}
}

// ---------------------------------------------------------------------------
// Backup filename builders
// ---------------------------------------------------------------------------

function todayStr(): string {
	return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function buildPreUpdateFilename(schemaVersion: number): string {
	const version = resolveAppVersion();
	const date = todayStr();
	return `cinephage-pre-update-${version}-schema${schemaVersion}-${date}.db`;
}

function buildScheduledFilename(): string {
	const ts = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
	return `cinephage-backup-${ts}.db`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DbBackupService {
	/**
	 * Run a backup before schema migrations.
	 * Called from initializeDatabase() when pending migrations are detected.
	 * Uses the raw sqlite handle (before Drizzle is involved).
	 */
	async runPreUpdateBackup(sqlite: Database.Database, schemaVersion: number): Promise<void> {
		await ensureDir(PRE_UPDATE_DIR);
		const filename = buildPreUpdateFilename(schemaVersion);
		const destPath = join(PRE_UPDATE_DIR, filename);

		logger.info({ destPath }, '[DbBackup] Running pre-update backup...');
		const start = Date.now();

		try {
			await sqlite.backup(destPath);
		} catch (err) {
			logger.error({ err, destPath }, '[DbBackup] Pre-update backup failed');
			return;
		}

		finalizeBackup(destPath);
		const ok = checkIntegrity(destPath);
		if (!ok) {
			logger.error(
				{ destPath },
				'[DbBackup] Pre-update backup failed integrity check — not pruning old backups'
			);
			return;
		}

		logger.info(
			{ destPath, durationMs: Date.now() - start },
			'[DbBackup] Pre-update backup complete'
		);
		await pruneBackups(PRE_UPDATE_DIR, PRE_UPDATE_KEEP);
	}

	/**
	 * Run a scheduled backup (called by the DbBackup task).
	 * Uses the Drizzle db instance (which wraps the same sqlite handle).
	 */
	async runScheduledBackup(
		sqlite: Database.Database
	): Promise<{ path: string; sizeBytes: number }> {
		const settings = await this.getSettings();
		const dir = settings.directory || DEFAULT_SCHEDULED_DIR;

		await ensureDir(dir);
		const filename = buildScheduledFilename();
		const destPath = join(dir, filename);

		logger.info({ destPath }, '[DbBackup] Running scheduled backup...');
		const start = Date.now();

		await sqlite.backup(destPath);
		finalizeBackup(destPath);

		const ok = checkIntegrity(destPath);
		if (!ok) {
			await unlink(destPath).catch(() => {});
			throw new Error(`Scheduled backup failed integrity check: ${destPath}`);
		}

		const s = await stat(destPath);
		logger.info(
			{ destPath, durationMs: Date.now() - start, sizeBytes: s.size },
			'[DbBackup] Scheduled backup complete'
		);

		await pruneBackups(dir, settings.retentionCount);
		return { path: destPath, sizeBytes: s.size };
	}

	async getSettings(): Promise<DbBackupSettings> {
		const [enabled, directory, retention] = await Promise.all([
			getSetting(SETTINGS_KEY_ENABLED),
			getSetting(SETTINGS_KEY_DIRECTORY),
			getSetting(SETTINGS_KEY_RETENTION)
		]);
		return {
			enabled: enabled !== 'false',
			directory: directory ?? '',
			retentionCount: retention ? parseInt(retention, 10) : DEFAULT_RETENTION
		};
	}

	async updateSettings(patch: Partial<DbBackupSettings>): Promise<void> {
		if (patch.enabled !== undefined) await setSetting(SETTINGS_KEY_ENABLED, String(patch.enabled));
		if (patch.directory !== undefined) {
			// Normalize: treat the default path the same as blank so DATA_DIR moves don't break backups
			const normalized =
				patch.directory.trim() === DEFAULT_SCHEDULED_DIR ? '' : patch.directory.trim();
			await setSetting(SETTINGS_KEY_DIRECTORY, normalized);
		}
		if (patch.retentionCount !== undefined)
			await setSetting(SETTINGS_KEY_RETENTION, String(patch.retentionCount));
	}

	async listScheduledBackups(): Promise<DbBackupFile[]> {
		const cfg = await this.getSettings();
		const dir = cfg.directory || DEFAULT_SCHEDULED_DIR;
		return listBackupFiles(dir);
	}

	async listPreUpdateBackups(): Promise<DbBackupFile[]> {
		return listBackupFiles(PRE_UPDATE_DIR);
	}
}

export const dbBackupService = new DbBackupService();

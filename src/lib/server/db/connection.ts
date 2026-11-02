import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The single owner of the application SQLite connection.
 *
 * Better Auth and the Drizzle data layer used to open separate connections
 * to the same file with different pragmas (auth had no WAL/busy_timeout/
 * foreign_keys) and different path resolution env chains, which risked
 * cross-connection lock contention and silently split databases when
 * AUTH_DATABASE_URL/DATABASE_URL diverged from DATA_DIR. Both now share
 * this handle.
 *
 * Path resolution precedence (one chain for everything):
 *   AUTH_DATABASE_URL -> DATABASE_URL -> ${DATA_DIR}/cinephage.db
 */

export function resolveDatabasePath(): string {
	return (
		process.env.AUTH_DATABASE_URL ||
		process.env.DATABASE_URL ||
		join(process.env.DATA_DIR || 'data', 'cinephage.db')
	);
}

export function ensureDatabaseDirectory(): void {
	const dbPath = resolveDatabasePath();

	// Skip URI-style and in-memory database targets.
	if (dbPath === ':memory:' || dbPath.startsWith('file:')) {
		return;
	}

	if (!existsSync(dirname(dbPath))) {
		mkdirSync(dirname(dbPath), { recursive: true });
	}
}

function createConnection(): Database.Database {
	ensureDatabaseDirectory();
	const sqlite = new Database(resolveDatabasePath());

	// Pragmas must never brick boot (the previous db/index.ts behavior logged
	// and continued); none of these are expected to fail on a writable file.
	try {
		// Improve concurrent read/write behavior during heavy background jobs (for example EPG sync).
		sqlite.pragma('journal_mode = WAL');
		sqlite.pragma('synchronous = NORMAL');
		sqlite.pragma('busy_timeout = 5000');
		sqlite.pragma('wal_autocheckpoint = 4000');
		sqlite.pragma('temp_store = MEMORY');
		sqlite.pragma('foreign_keys = ON');
		// 32MB page cache: reduces re-reads of hot tables (episodes, storage_items, episode_files)
		// during reconcile and scan passes on large libraries.
		sqlite.pragma('cache_size = -32000');
	} catch {
		// Continue with SQLite defaults rather than making the app unstartable.
	}

	return sqlite;
}

let connection: Database.Database | null = null;

/**
 * The shared SQLite handle, created lazily so importing the module (tests,
 * tooling) never touches the filesystem. Better Auth's tables declare
 * foreign keys and its schema expects them enforced, so FK-ON here matches
 * its assumptions.
 */
export function getSharedSqliteConnection(): Database.Database {
	if (!connection) {
		connection = createConnection();
	}
	return connection;
}

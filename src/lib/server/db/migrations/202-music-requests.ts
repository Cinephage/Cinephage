import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 202: a request can be a music album.
 *
 * Requests were built on TMDB identity: `tmdb_id` was NOT NULL and there was
 * nowhere to put a MusicBrainz release-group id or the library album it
 * becomes. A music request carries the release group instead of a TMDB id, so
 * `tmdb_id` becomes nullable and the row gains `mbid`, `album_id` and
 * `cover_url` (an absolute URL; `poster_path` stays TMDB-relative).
 *
 * SQLite cannot drop NOT NULL in place, so the table is rebuilt from its live
 * DDL - the same pattern as v201: read `sqlite_master`, add the new columns to
 * the CREATE, copy by column name, swap, replay the indexes, and assert the row
 * count did not move. Idempotent: a table that already has `mbid` and a
 * nullable `tmdb_id` is left alone.
 *
 * `user_request_settings` only gains two nullable columns, so it is altered in
 * place.
 */

const NEW_COLUMNS = [
	'"mbid" text',
	'"album_id" text REFERENCES "albums"("id") ON DELETE SET NULL',
	'"cover_url" text'
];

interface ColumnInfo {
	name: string;
	notnull: number;
}

/** Split a CREATE TABLE body on top-level commas, respecting quotes and nested parens. */
function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let current = '';
	let depth = 0;
	let quote: string | null = null;

	for (const char of body) {
		if (quote) {
			current += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === '`') {
			quote = char;
			current += char;
			continue;
		}
		if (char === '(') depth += 1;
		if (char === ')') depth -= 1;
		if (char === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

/** Add column definitions before any table-level constraint. */
function addColumnsToCreate(sql: string, definitions: string[]): string {
	const open = sql.indexOf('(');
	const close = sql.lastIndexOf(')');
	if (open === -1 || close === -1 || close < open) {
		throw new Error('Could not find the requests column list');
	}
	const parts = splitTopLevel(sql.slice(open + 1, close));
	const constraint = /^\s*(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i;
	const firstConstraint = parts.findIndex((part) => constraint.test(part));
	const insertAt = firstConstraint === -1 ? parts.length : firstConstraint;
	parts.splice(insertAt, 0, ...definitions);
	return `${sql.slice(0, open + 1)}${parts.join(',')}${sql.slice(close)}`;
}

function tableSql(sqlite: Database.Database, table: string): string | null {
	const row = sqlite
		.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(table) as { sql: string } | undefined;
	return row?.sql ?? null;
}

function indexSql(sqlite: Database.Database, table: string): string[] {
	const rows = sqlite
		.prepare(
			`SELECT sql FROM sqlite_master
			 WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
			 ORDER BY name`
		)
		.all(table) as { sql: string }[];
	return rows.map((row) => row.sql);
}

function rowCount(sqlite: Database.Database, table: string): number {
	return (sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

function columns(sqlite: Database.Database, table: string): ColumnInfo[] {
	return sqlite.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
}

function ensureMusicIndexes(sqlite: Database.Database): void {
	sqlite
		.prepare(
			`CREATE INDEX IF NOT EXISTS "idx_requests_media_mbid" ON "requests" ("media_type", "mbid", "status")`
		)
		.run();
	sqlite
		.prepare(`CREATE INDEX IF NOT EXISTS "idx_requests_album" ON "requests" ("album_id")`)
		.run();
}

function ensureUserQuotaColumns(sqlite: Database.Database): void {
	if (!tableSql(sqlite, 'user_request_settings')) return;
	const existing = new Set(columns(sqlite, 'user_request_settings').map((column) => column.name));
	if (!existing.has('music_quota_limit')) {
		sqlite.prepare(`ALTER TABLE "user_request_settings" ADD COLUMN "music_quota_limit" integer`).run();
	}
	if (!existing.has('music_quota_days')) {
		sqlite.prepare(`ALTER TABLE "user_request_settings" ADD COLUMN "music_quota_days" integer`).run();
	}
}

export const migration_v202: MigrationDefinition = {
	version: 202,
	name: 'music_requests',
	apply: (sqlite) => {
		ensureUserQuotaColumns(sqlite);

		const sql = tableSql(sqlite, 'requests');
		// syncSchema creates every table before migrations; a missing table means
		// a partial database, where there is nothing to widen.
		if (!sql) return;

		const cols = columns(sqlite, 'requests');
		const hasMbid = cols.some((column) => column.name === 'mbid');
		const tmdbNotNull = cols.find((column) => column.name === 'tmdb_id')?.notnull === 1;
		if (hasMbid && !tmdbNotNull) {
			ensureMusicIndexes(sqlite);
			return;
		}

		let rewritten = sql.replace(/"tmdb_id"\s+integer\s+NOT NULL/i, '"tmdb_id" integer');
		if (!/"tmdb_id"\s+integer/i.test(rewritten)) {
			throw new Error('Could not make requests.tmdb_id nullable');
		}
		if (!hasMbid) {
			rewritten = addColumnsToCreate(rewritten, NEW_COLUMNS);
		}

		const staging = 'requests__v202';
		const createSql = rewritten.replace(
			/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\S+)/i,
			`CREATE TABLE "${staging}"`
		);
		if (createSql === rewritten) {
			throw new Error('Could not rename the requests CREATE TABLE');
		}

		const indexes = indexSql(sqlite, 'requests');
		const before = rowCount(sqlite, 'requests');
		const existingColumns = cols.map((column) => `"${column.name}"`).join(', ');

		sqlite.prepare(`DROP TABLE IF EXISTS "${staging}"`).run();
		sqlite.prepare(createSql).run();
		sqlite
			.prepare(
				`INSERT INTO "${staging}" (${existingColumns}) SELECT ${existingColumns} FROM "requests"`
			)
			.run();
		sqlite.prepare(`DROP TABLE "requests"`).run();
		sqlite.prepare(`ALTER TABLE "${staging}" RENAME TO "requests"`).run();
		for (const index of indexes) sqlite.prepare(index).run();
		ensureMusicIndexes(sqlite);

		const after = rowCount(sqlite, 'requests');
		if (after !== before) {
			throw new Error(`Rebuild of "requests" lost rows: ${before} → ${after}`);
		}
	}
};

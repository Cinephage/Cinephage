import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 201: a smart list item can be a music album.
 *
 * The list table was built for TMDB rows: `tmdb_id` was NOT NULL and there was
 * nowhere to put a release-group id, its artist or the library album it becomes.
 * Music lists need exactly that, so the row gains the music identity columns and
 * `tmdb_id` becomes nullable.
 *
 * SQLite cannot drop NOT NULL in place, so this rebuilds the table from its live
 * DDL — the same pattern as v181: read `sqlite_master` (not TABLE_DEFINITIONS,
 * which is the *initial* shape and lacks every column later migrations added),
 * copy, swap, replay the table's indexes, and assert the row count did not move.
 *
 * The new columns are appended at the end of the CREATE so `INSERT … SELECT *`
 * keeps the existing columns aligned; ordering is irrelevant to Drizzle, which
 * selects by name. Idempotent: a table that already has `mbid` and a nullable
 * `tmdb_id` is left alone.
 */

const NEW_COLUMNS = [
	'"mbid" text',
	'"artist_name" text',
	'"artist_mbid" text',
	'"album_id" text REFERENCES "albums"("id") ON DELETE SET NULL',
	'"cover_url" text',
	'"track_count" integer',
	'"primary_type" text'
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

/**
 * Add column definitions before any table-level constraint. SQLite's grammar
 * puts table constraints after every column, so appending at the end of the
 * DDL is only valid for a table that has none (the live table does, a test or
 * future table may not).
 */
function addColumnsToCreate(sql: string, definitions: string[]): string {
	const open = sql.indexOf('(');
	const close = sql.lastIndexOf(')');
	if (open === -1 || close === -1 || close < open) {
		throw new Error('Could not find the smart_list_items column list');
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

/** The music indexes, including the per-list release-group uniqueness guard. */
function ensureMusicIndexes(sqlite: Database.Database): void {
	sqlite
		.prepare(
			`CREATE INDEX IF NOT EXISTS "idx_smart_list_items_mbid" ON "smart_list_items" ("mbid", "media_type")`
		)
		.run();
	sqlite
		.prepare(
			`CREATE INDEX IF NOT EXISTS "idx_smart_list_items_album" ON "smart_list_items" ("album_id")`
		)
		.run();
	sqlite
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_smart_list_items_list_mbid" ON "smart_list_items" ("smart_list_id", "mbid") WHERE "mbid" IS NOT NULL`
		)
		.run();
}

export const migration_v201: MigrationDefinition = {
	version: 201,
	name: 'music_smart_list_items',
	apply: (sqlite) => {
		const sql = tableSql(sqlite, 'smart_list_items');
		// syncSchema creates every table before migrations; a missing table means
		// a partial database, where there is nothing to widen.
		if (!sql) return;

		const cols = columns(sqlite, 'smart_list_items');
		const hasMbid = cols.some((column) => column.name === 'mbid');
		const tmdbNotNull = cols.find((column) => column.name === 'tmdb_id')?.notnull === 1;
		if (hasMbid && !tmdbNotNull) {
			ensureMusicIndexes(sqlite);
			return;
		}

		let rewritten = sql.replace(/"tmdb_id"\s+integer\s+NOT NULL/i, '"tmdb_id" integer');
		if (!/"tmdb_id"\s+integer/i.test(rewritten)) {
			throw new Error('Could not make smart_list_items.tmdb_id nullable');
		}

		if (!hasMbid) {
			rewritten = addColumnsToCreate(rewritten, NEW_COLUMNS);
		}

		const staging = 'smart_list_items__v201';
		const createSql = rewritten.replace(
			/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\S+)/i,
			`CREATE TABLE "${staging}"`
		);
		if (createSql === rewritten) {
			throw new Error('Could not rename the smart_list_items CREATE TABLE');
		}

		const indexes = indexSql(sqlite, 'smart_list_items');
		const before = rowCount(sqlite, 'smart_list_items');
		// The staging table is wider than the source; map by name so the copy does
		// not depend on column order or count.
		const existingColumns = cols.map((column) => `"${column.name}"`).join(', ');

		sqlite.prepare(`DROP TABLE IF EXISTS "${staging}"`).run();
		sqlite.prepare(createSql).run();
		sqlite
			.prepare(
				`INSERT INTO "${staging}" (${existingColumns}) SELECT ${existingColumns} FROM "smart_list_items"`
			)
			.run();
		sqlite.prepare(`DROP TABLE "smart_list_items"`).run();
		sqlite.prepare(`ALTER TABLE "${staging}" RENAME TO "smart_list_items"`).run();
		for (const index of indexes) sqlite.prepare(index).run();

		// Recreate every music index (the table was rebuilt without them).
		ensureMusicIndexes(sqlite);

		const after = rowCount(sqlite, 'smart_list_items');
		if (after !== before) {
			throw new Error(`Rebuild of "smart_list_items" lost rows: ${before} → ${after}`);
		}
	}
};

import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 181: let a library (and the tables that mirror its kind) hold music.
 *
 * SQLite has no `ALTER TABLE ... DROP/ADD CONSTRAINT`: every CHECK change is a
 * table rebuild (create → copy → drop → rename). Five tables carry the same
 * two-value `media_type` CHECK, so one helper rebuilds them instead of five
 * hand-written copies:
 *
 *   libraries, smart_lists, smart_list_items, stream_extraction_cache — ('movie', 'tv')
 *   alternate_titles — ('movie', 'series')   ← its own vocabulary, preserved
 *
 * Two things the rebuild must get right:
 *
 * 1. **Rebuild from the live DDL in `sqlite_master`, never from
 *    `TABLE_DEFINITIONS`.** Those definitions are the *initial* shape; later
 *    migrations appended columns with ALTER (`libraries.quality_profile_id`,
 *    `scan_mode`, `scan_config`, …). Building from the definition drops them,
 *    and `INSERT … SELECT *` then fails on the column count.
 * 2. **Recreate the table's own indexes.** `syncSchema` runs INDEX_DEFINITIONS
 *    *before* migrations, so indexes lost to the DROP would not return until
 *    the next boot. They are captured before the drop and replayed after.
 *
 * Idempotent: a table whose CHECK already lists the value is left alone, so a
 * fresh install (whose DDL is already widened) sees five no-ops. Row counts are
 * asserted around each rebuild so a partial copy aborts inside the migration
 * transaction instead of committing a truncated table.
 *
 * Not rebuilt here: `metadata_conflicts.media_type` (plain text, no CHECK) and
 * `media_browser_servers` (gates `server_type`, not the media kind).
 */

const MEDIA_TYPE_CHECK = /CHECK\s*\(\s*"media_type"\s+IN\s*\(([^)]*)\)\s*\)/i;

/** Values inside a `media_type` CHECK list, in declaration order; null when there is no such CHECK. */
function checkValues(sql: string): string[] | null {
	const match = MEDIA_TYPE_CHECK.exec(sql);
	if (!match) return null;
	return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
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

/**
 * Rebuild `table` with `value` added to its `media_type` CHECK list.
 * No-op when the table has no such CHECK or already lists the value.
 */
function widenMediaTypeCheck(sqlite: Database.Database, table: string, value: string): void {
	const sql = tableSql(sqlite, table);
	// A missing table is not this migration's problem: `syncSchema` creates every
	// table from TABLE_DEFINITIONS before migrations run, so this only fires on a
	// partial database, where there is nothing to widen.
	if (!sql) return;
	const values = checkValues(sql);
	if (!values || values.includes(value)) return;

	const widened = values
		.concat(value)
		.map((v) => `'${v}'`)
		.join(', ');
	const withCheck = sql.replace(MEDIA_TYPE_CHECK, `CHECK ("media_type" IN (${widened}))`);
	if (withCheck === sql) throw new Error(`Could not rewrite the media_type CHECK on "${table}"`);

	const staging = `${table}__v181`;
	const createSql = withCheck.replace(
		/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\S+)/i,
		`CREATE TABLE "${staging}"`
	);
	if (createSql === withCheck) throw new Error(`Could not rename the CREATE TABLE on "${table}"`);

	const indexes = indexSql(sqlite, table);
	const before = rowCount(sqlite, table);

	sqlite.prepare(`DROP TABLE IF EXISTS "${staging}"`).run();
	sqlite.prepare(createSql).run();
	sqlite.prepare(`INSERT INTO "${staging}" SELECT * FROM "${table}"`).run();
	sqlite.prepare(`DROP TABLE "${table}"`).run();
	sqlite.prepare(`ALTER TABLE "${staging}" RENAME TO "${table}"`).run();
	for (const index of indexes) sqlite.prepare(index).run();

	const after = rowCount(sqlite, table);
	if (after !== before) {
		throw new Error(`Rebuild of "${table}" lost rows: ${before} → ${after}`);
	}
}

const WIDENED_TABLES = [
	'libraries',
	'smart_lists',
	'smart_list_items',
	'stream_extraction_cache',
	'alternate_titles'
];

export const migration_v181: MigrationDefinition = {
	version: 181,
	name: 'widen_media_type_check_for_music',
	apply: (sqlite) => {
		for (const table of WIDENED_TABLES) widenMediaTypeCheck(sqlite, table, 'music');
	}
};

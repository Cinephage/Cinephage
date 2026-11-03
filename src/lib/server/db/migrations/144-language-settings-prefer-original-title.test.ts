import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v144 } from './144-language-settings-prefer-original-title.js';

const databases: Database.Database[] = [];

/**
 * Minimal pre-v141 fixture mirroring the shipped language_settings shape
 * (migration 137): singleton row without the prefer_original_title column.
 */
const PRE_MIGRATION_DDL = `
	CREATE TABLE "language_settings" (
		"id" text PRIMARY KEY NOT NULL DEFAULT 'singleton',
		"default_profile_id" text,
		"metadata_locale" text DEFAULT 'en-US' NOT NULL,
		"region" text DEFAULT 'US' NOT NULL,
		"discover_original_filter" text,
		"unknown_subtitle_policy" text DEFAULT 'und' NOT NULL,
		"assumed_language" text,
		"auto_sync_subtitles" integer DEFAULT true NOT NULL,
		"updated_at" text
	)
`;

const SEED_SQL = `
	-- Existing singleton row: must keep its data and default to 0.
	INSERT INTO language_settings (id, default_profile_id, metadata_locale, region, auto_sync_subtitles, updated_at)
		VALUES ('singleton', 'a0000000-0000-4000-8000-000000000001', 'de-DE', 'DE', 0, '2026-01-01');
`;

function createPreMigrationDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(PRE_MIGRATION_DDL);
	sqlite.exec(SEED_SQL);
	return sqlite;
}

function getColumns(
	sqlite: Database.Database
): Array<{ name: string; dflt_value: string | null; notnull: number }> {
	return sqlite.prepare(`PRAGMA table_info("language_settings")`).all() as Array<{
		name: string;
		dflt_value: string | null;
		notnull: number;
	}>;
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('migration v141 - language_settings.prefer_original_title', () => {
	it('adds the prefer_original_title column (NOT NULL, default 0)', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v144.apply(sqlite);

		const column = getColumns(sqlite).find((c) => c.name === 'prefer_original_title');
		expect(column).toBeDefined();
		expect(column?.notnull).toBe(1);
		// Stored default is the integer 0 (boolean false in drizzle's mode).
		expect(String(column?.dflt_value)).toContain('0');
	});

	it('defaults existing rows to 0 while preserving their data', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v144.apply(sqlite);

		const row = sqlite
			.prepare(
				`SELECT default_profile_id, metadata_locale, region, auto_sync_subtitles, prefer_original_title
				 FROM language_settings WHERE id = 'singleton'`
			)
			.get() as Record<string, unknown>;

		expect(row.prefer_original_title).toBe(0);
		// Untouched columns survive the migration.
		expect(row.default_profile_id).toBe('a0000000-0000-4000-8000-000000000001');
		expect(row.metadata_locale).toBe('de-DE');
		expect(row.region).toBe('DE');
		expect(row.auto_sync_subtitles).toBe(0);
	});

	it('is idempotent: a second apply changes nothing', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v144.apply(sqlite);
		const afterFirst = sqlite.prepare('SELECT * FROM language_settings').all();
		const columnsFirst = getColumns(sqlite).map((c) => c.name);

		expect(() => migration_v144.apply(sqlite)).not.toThrow();
		expect(sqlite.prepare('SELECT * FROM language_settings').all()).toEqual(afterFirst);
		expect(getColumns(sqlite).filter((c) => c.name === 'prefer_original_title')).toHaveLength(1);
		expect(getColumns(sqlite).map((c) => c.name)).toEqual(columnsFirst);
	});

	it('does nothing when language_settings does not exist yet', () => {
		const sqlite = new Database(':memory:');
		databases.push(sqlite);

		expect(() => migration_v144.apply(sqlite)).not.toThrow();
		const tables = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(tables).not.toContain('language_settings');
	});
});

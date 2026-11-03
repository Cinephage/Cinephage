import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v146 } from './146-subtitle-requirement-overrides.js';
import { getSchemaVersion } from '../migration-helpers.js';
import { CURRENT_SCHEMA_VERSION } from '../schema-sync.js';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';

const databases: Database.Database[] = [];

/**
 * Legacy (pre-v143) shape: items carry language_profile_id overrides but no
 * subtitle_requirements_override column. language_settings holds the instance
 * default (profile-default). Fixture state:
 * - movie-stamped / series-stamped: override == instance default (auto stamp)
 * - movie-custom / series-custom: override differs (deliberate user choice)
 * - movie-null: no override at all
 */
const PRE_MIGRATION_DDL = `
	CREATE TABLE "language_settings" (
		"id" text PRIMARY KEY NOT NULL,
		"default_profile_id" text,
		"metadata_locale" text NOT NULL DEFAULT 'en-US',
		"region" text NOT NULL DEFAULT 'US',
		"auto_sync_subtitles" integer NOT NULL DEFAULT 1,
		"updated_at" text
	);

	CREATE TABLE "movies" (
		"id" text PRIMARY KEY NOT NULL,
		"tmdb_id" integer NOT NULL,
		"title" text NOT NULL,
		"language_profile_id" text
	);

	CREATE TABLE "series" (
		"id" text PRIMARY KEY NOT NULL,
		"tmdb_id" integer NOT NULL,
		"title" text NOT NULL,
		"language_profile_id" text
	);

	CREATE TABLE "episodes" (
		"id" text PRIMARY KEY NOT NULL,
		"series_id" text NOT NULL,
		"season_number" integer NOT NULL,
		"episode_number" integer NOT NULL
	);
`;

const SEED_SQL = `
	INSERT INTO language_settings (id, default_profile_id)
		VALUES ('singleton', 'profile-default');

	INSERT INTO movies (id, tmdb_id, title, language_profile_id)
		VALUES
			('movie-stamped', 101, 'Stamped', 'profile-default'),
			('movie-custom', 102, 'Custom', 'profile-own'),
			('movie-null', 103, 'Null', NULL);

	INSERT INTO series (id, tmdb_id, title, language_profile_id)
		VALUES
			('series-stamped', 201, 'Stamped', 'profile-default'),
			('series-custom', 202, 'Custom', 'profile-own');

	INSERT INTO episodes (id, series_id, season_number, episode_number)
		VALUES ('ep-1', 'series-stamped', 1, 1);
`;

function createPreMigrationDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(PRE_MIGRATION_DDL);
	sqlite.exec(SEED_SQL);
	sqlite.pragma('foreign_keys = OFF');
	return sqlite;
}

function getColumnNames(sqlite: Database.Database, tableName: string): string[] {
	return (sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map(
		(column) => column.name
	);
}

let testDb: TestDatabase | null = null;

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
	if (testDb) {
		destroyTestDb(testDb);
		testDb = null;
	}
});

describe('migration v143 - subtitle requirement overrides + inheritance repair', () => {
	it('adds the override column and nulls auto-stamped defaults, keeping deliberate overrides', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v146.apply(sqlite);

		for (const table of ['movies', 'series', 'episodes']) {
			expect(getColumnNames(sqlite, table)).toContain('subtitle_requirements_override');
		}

		const movies = sqlite
			.prepare(`SELECT id, language_profile_id FROM movies ORDER BY id`)
			.all() as Array<{ id: string; language_profile_id: string | null }>;
		expect(movies).toEqual([
			{ id: 'movie-custom', language_profile_id: 'profile-own' },
			{ id: 'movie-null', language_profile_id: null },
			{ id: 'movie-stamped', language_profile_id: null }
		]);

		const series = sqlite
			.prepare(`SELECT id, language_profile_id FROM series ORDER BY id`)
			.all() as Array<{ id: string; language_profile_id: string | null }>;
		expect(series).toEqual([
			{ id: 'series-custom', language_profile_id: 'profile-own' },
			{ id: 'series-stamped', language_profile_id: null }
		]);

		// The settings singleton is untouched.
		const settings = sqlite
			.prepare(`SELECT default_profile_id FROM language_settings WHERE id = 'singleton'`)
			.get() as { default_profile_id: string };
		expect(settings.default_profile_id).toBe('profile-default');
	});

	it('is a no-op when no instance default is configured', () => {
		const sqlite = createPreMigrationDatabase();
		sqlite.exec(`UPDATE language_settings SET default_profile_id = NULL`);

		migration_v146.apply(sqlite);

		const stamped = sqlite
			.prepare(`SELECT language_profile_id FROM movies WHERE id = 'movie-stamped'`)
			.get() as { language_profile_id: string };
		expect(stamped.language_profile_id).toBe('profile-default');
	});

	it('is idempotent: a second apply neither errors nor changes data', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v146.apply(sqlite);
		const moviesAfterFirst = sqlite
			.prepare(`SELECT id, language_profile_id FROM movies ORDER BY id`)
			.all();

		expect(() => migration_v146.apply(sqlite)).not.toThrow();
		expect(sqlite.prepare(`SELECT id, language_profile_id FROM movies ORDER BY id`).all()).toEqual(
			moviesAfterFirst
		);
	});

	it('is consistent with the fresh-DB path: syncSchema leaves the columns in place', () => {
		testDb = createTestDb();
		const sqlite = testDb.sqlite;

		for (const table of ['movies', 'series', 'episodes']) {
			expect(getColumnNames(sqlite, table)).toContain('subtitle_requirements_override');
		}

		expect(getSchemaVersion(sqlite)).toBe(CURRENT_SCHEMA_VERSION);
	});
});

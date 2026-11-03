import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v151 } from './151-language-system-column-guards.js';

const databases: Database.Database[] = [];

/**
 * Minimal pre-m151 fixture: language-system tables without the columns that
 * were only ever declared in schema.ts / the fresh-install DDL. Notably
 * `episodes.wants_subtitles_override` had no owning migration at all.
 */
const PRE_MIGRATION_DDL = `
	CREATE TABLE "movies" (
		"id" text PRIMARY KEY NOT NULL,
		"tmdb_id" integer NOT NULL,
		"title" text NOT NULL
	);
	CREATE TABLE "series" (
		"id" text PRIMARY KEY NOT NULL,
		"tmdb_id" integer NOT NULL,
		"title" text NOT NULL
	);
	CREATE TABLE "episodes" (
		"id" text PRIMARY KEY NOT NULL,
		"series_id" text NOT NULL,
		"season_number" integer NOT NULL,
		"episode_number" integer NOT NULL
	);
	CREATE TABLE "libraries" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL
	);
	CREATE TABLE "smart_lists" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL
	);
	CREATE TABLE "language_settings" (
		"id" text PRIMARY KEY NOT NULL DEFAULT 'singleton',
		"default_profile_id" text
	);
	CREATE TABLE "subtitles" (
		"id" text PRIMARY KEY NOT NULL,
		"language" text
	);
	CREATE TABLE "media_server_synced_items" (
		"id" text PRIMARY KEY NOT NULL,
		"server_id" text
	);
	CREATE TABLE "epg_programs" (
		"id" text PRIMARY KEY NOT NULL,
		"title" text
	);
`;

const SEED_SQL = `
	INSERT INTO movies (id, tmdb_id, title) VALUES ('m1', 1, 'Movie');
	INSERT INTO episodes (id, series_id, season_number, episode_number)
		VALUES ('e1', 's1', 1, 1);
	INSERT INTO language_settings (id, default_profile_id) VALUES ('singleton', NULL);
`;

function createPreMigrationDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(PRE_MIGRATION_DDL);
	sqlite.exec(SEED_SQL);
	return sqlite;
}

function getColumnNames(sqlite: Database.Database, table: string): string[] {
	return (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
		(c) => c.name
	);
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('migration v151 - language system column guards', () => {
	it('adds the episode tri-state gate and the other missing language columns', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v151.apply(sqlite);

		expect(getColumnNames(sqlite, 'episodes')).toContain('wants_subtitles_override');
		expect(getColumnNames(sqlite, 'episodes')).toContain('subtitle_requirements_override');
		expect(getColumnNames(sqlite, 'movies')).toContain('subtitle_requirements_override');
		expect(getColumnNames(sqlite, 'series')).toContain('subtitle_requirements_override');
		expect(getColumnNames(sqlite, 'movies')).toContain('language_profile_id');
		expect(getColumnNames(sqlite, 'movies')).toContain('metadata_language_mode');
		expect(getColumnNames(sqlite, 'movies')).toContain('language_shortfall');
		expect(getColumnNames(sqlite, 'libraries')).toContain('language_profile_id');
		expect(getColumnNames(sqlite, 'smart_lists')).toContain('language_profile_id');
		expect(getColumnNames(sqlite, 'language_settings')).toContain('prefer_original_title');
		expect(getColumnNames(sqlite, 'subtitles')).toContain('last_checked_at');
		expect(getColumnNames(sqlite, 'media_server_synced_items')).toContain('audio_languages_raw');
		expect(getColumnNames(sqlite, 'epg_programs')).toContain('title_i18n');
	});

	it('preserves existing rows', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v151.apply(sqlite);

		const movie = sqlite.prepare(`SELECT title FROM movies WHERE id = 'm1'`).get() as {
			title: string;
		};
		expect(movie.title).toBe('Movie');
		const settings = sqlite
			.prepare(`SELECT default_profile_id FROM language_settings WHERE id = 'singleton'`)
			.get() as { default_profile_id: string | null };
		expect(settings.default_profile_id).toBeNull();
	});

	it('is idempotent: a second apply adds no duplicate columns', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v151.apply(sqlite);
		const firstColumns = getColumnNames(sqlite, 'episodes');

		expect(() => migration_v151.apply(sqlite)).not.toThrow();
		expect(getColumnNames(sqlite, 'episodes')).toEqual(firstColumns);
		expect(
			getColumnNames(sqlite, 'episodes').filter((c) => c === 'wants_subtitles_override')
		).toHaveLength(1);
	});

	it('does nothing when the target tables do not exist', () => {
		const sqlite = new Database(':memory:');
		databases.push(sqlite);

		expect(() => migration_v151.apply(sqlite)).not.toThrow();
		const tables = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(tables).toHaveLength(0);
	});
});

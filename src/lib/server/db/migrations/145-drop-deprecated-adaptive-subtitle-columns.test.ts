import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v145 } from './145-drop-deprecated-adaptive-subtitle-columns.js';
import { getSchemaVersion } from '../migration-helpers.js';
import { CURRENT_SCHEMA_VERSION } from '../schema-sync.js';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';

const databases: Database.Database[] = [];

/**
 * Legacy (pre-v142) shape: movies/episodes still carry the per-item adaptive
 * columns added by migration 072 (deprecated since 138) alongside the columns
 * that must survive - notably last_search_time, which remains in active use by
 * the release-search cooldown.
 */
const PRE_MIGRATION_DDL = `
	CREATE TABLE "movies" (
		"id" text PRIMARY KEY NOT NULL,
		"tmdb_id" integer NOT NULL,
		"title" text NOT NULL,
		"has_file" integer DEFAULT false,
		"last_search_time" text,
		"failed_subtitle_attempts" integer DEFAULT 0,
		"first_subtitle_search_at" text
	);

	CREATE TABLE "episodes" (
		"id" text PRIMARY KEY NOT NULL,
		"series_id" text NOT NULL,
		"season_number" integer NOT NULL,
		"episode_number" integer NOT NULL,
		"title" text,
		"last_search_time" text,
		"failed_subtitle_attempts" integer DEFAULT 0,
		"first_subtitle_search_at" text
	);
`;

const SEED_SQL = `
	INSERT INTO movies (id, tmdb_id, title, has_file, last_search_time, failed_subtitle_attempts, first_subtitle_search_at)
		VALUES ('movie-1', 101, 'Alpha', 1, '2025-06-01T00:00:00.000Z', 3, '2025-05-01T00:00:00.000Z');
	INSERT INTO movies (id, tmdb_id, title, has_file, last_search_time)
		VALUES ('movie-2', 202, 'Beta', 0, NULL);
	INSERT INTO episodes (id, series_id, season_number, episode_number, title, last_search_time, failed_subtitle_attempts, first_subtitle_search_at)
		VALUES ('ep-1', 'series-1', 1, 1, 'Pilot', '2025-07-01T00:00:00.000Z', 5, '2025-06-01T00:00:00.000Z');
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

const DEPRECATED_COLUMNS = ['failed_subtitle_attempts', 'first_subtitle_search_at'];

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

describe('migration v142 - drop deprecated adaptive subtitle columns', () => {
	it('drops the deprecated columns from movies and episodes and keeps other data intact', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v145.apply(sqlite);

		for (const table of ['movies', 'episodes']) {
			const columns = getColumnNames(sqlite, table);
			for (const column of DEPRECATED_COLUMNS) {
				expect(columns).not.toContain(column);
			}
			expect(columns).toContain('last_search_time');
		}

		// Row data in surviving columns is untouched.
		const movies = sqlite
			.prepare(`SELECT id, title, has_file, last_search_time FROM movies ORDER BY id`)
			.all() as Array<Record<string, unknown>>;
		expect(movies).toEqual([
			{
				id: 'movie-1',
				title: 'Alpha',
				has_file: 1,
				last_search_time: '2025-06-01T00:00:00.000Z'
			},
			{ id: 'movie-2', title: 'Beta', has_file: 0, last_search_time: null }
		]);

		const episode = sqlite.prepare(`SELECT * FROM episodes WHERE id = 'ep-1'`).get() as Record<
			string,
			unknown
		>;
		expect(episode).toMatchObject({
			id: 'ep-1',
			series_id: 'series-1',
			season_number: 1,
			episode_number: 1,
			title: 'Pilot',
			last_search_time: '2025-07-01T00:00:00.000Z'
		});

		// Inserts against the slimmed tables still work.
		expect(() =>
			sqlite
				.prepare(`INSERT INTO movies (id, tmdb_id, title) VALUES ('movie-3', 303, 'Gamma')`)
				.run()
		).not.toThrow();
	});

	it('is idempotent: a second apply neither errors nor changes the schema', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v145.apply(sqlite);
		const moviesAfterFirst = getColumnNames(sqlite, 'movies');
		const episodesAfterFirst = getColumnNames(sqlite, 'episodes');

		expect(() => migration_v145.apply(sqlite)).not.toThrow();
		expect(getColumnNames(sqlite, 'movies')).toEqual(moviesAfterFirst);
		expect(getColumnNames(sqlite, 'episodes')).toEqual(episodesAfterFirst);
	});

	it('is consistent with the fresh-DB path: syncSchema never leaves the columns behind', () => {
		// createTestDb runs the full syncSchema (DDL + pending migration chain) on
		// an empty database, i.e. exactly the fresh-install path. 137's rebuild
		// re-adds the columns mid-chain; 142 must remove them again.
		testDb = createTestDb();
		const sqlite = testDb.sqlite;

		for (const table of ['movies', 'episodes']) {
			const columns = getColumnNames(sqlite, table);
			for (const column of DEPRECATED_COLUMNS) {
				expect(columns).not.toContain(column);
			}
			expect(columns).toContain('last_search_time');
		}

		expect(getSchemaVersion(sqlite)).toBe(CURRENT_SCHEMA_VERSION);
	});
});

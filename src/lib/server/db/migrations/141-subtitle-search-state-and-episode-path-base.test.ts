import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v141 } from './141-subtitle-search-state-and-episode-path-base.js';

const databases: Database.Database[] = [];

/**
 * Minimal pre-v141 fixture. Mirrors the shipped subtitles/episode_files shapes
 * (episode_files.episode_ids is a JSON array) plus the deprecated per-item
 * adaptive columns on movies/episodes, which must survive untouched.
 */
const PRE_MIGRATION_DDL = `
	CREATE TABLE "subtitles" (
		"id" text PRIMARY KEY NOT NULL,
		"movie_id" text,
		"episode_id" text,
		"relative_path" text NOT NULL,
		"language" text NOT NULL,
		"format" text NOT NULL
	);

	CREATE TABLE "movies" (
		"id" text PRIMARY KEY NOT NULL,
		"failed_subtitle_attempts" integer DEFAULT 0,
		"first_subtitle_search_at" text,
		"last_search_time" text
	);

	CREATE TABLE "episodes" (
		"id" text PRIMARY KEY NOT NULL,
		"failed_subtitle_attempts" integer DEFAULT 0,
		"first_subtitle_search_at" text,
		"last_search_time" text
	);

	CREATE TABLE "episode_files" (
		"id" text PRIMARY KEY NOT NULL,
		"series_id" text NOT NULL,
		"season_number" integer NOT NULL,
		"episode_ids" text,
		"relative_path" text NOT NULL
	);
`;

const SEED_SQL = `
	-- (a) season prefix -> stripped
	INSERT INTO episode_files (id, series_id, season_number, episode_ids, relative_path)
		VALUES ('ef-a', 'series-1', 1, '["ep-a"]', 'Season 01/Ep.mkv');
	INSERT INTO subtitles (id, episode_id, relative_path, language, format)
		VALUES ('sub-a', 'ep-a', 'Season 01/Ep.en.srt', 'en', 'srt');

	-- (b) already episode-dir-relative -> unchanged
	INSERT INTO episode_files (id, series_id, season_number, episode_ids, relative_path)
		VALUES ('ef-b', 'series-1', 1, '["ep-b"]', 'Season 01/Ep2.mkv');
	INSERT INTO subtitles (id, episode_id, relative_path, language, format)
		VALUES ('sub-b', 'ep-b', 'Ep2.en.srt', 'en', 'srt');

	-- (c) nested season/Subs prefix -> only the season segment stripped
	INSERT INTO episode_files (id, series_id, season_number, episode_ids, relative_path)
		VALUES ('ef-c', 'series-1', 1, '["ep-c"]', 'Season 01/Ep3.mkv');
	INSERT INTO subtitles (id, episode_id, relative_path, language, format)
		VALUES ('sub-c', 'ep-c', 'Season 01/Subs/Ep3.en.srt', 'en', 'srt');

	-- (d) no owning episode file -> unresolvable, untouched
	INSERT INTO subtitles (id, episode_id, relative_path, language, format)
		VALUES ('sub-d', 'ep-d', 'Season 01/Ep4.en.srt', 'en', 'srt');

	-- (e) Windows separators -> stripped to forward-slash episode-dir base
	INSERT INTO episode_files (id, series_id, season_number, episode_ids, relative_path)
		VALUES ('ef-win', 'series-1', 2, '["ep-win"]', 'Season 02\\Ep5.mkv');
	INSERT INTO subtitles (id, episode_id, relative_path, language, format)
		VALUES ('sub-win', 'ep-win', 'Season 02\\Ep5.en.srt', 'en', 'srt');

	-- (f) resolvable file but sidecar not under the episode dir -> untouched
	INSERT INTO episode_files (id, series_id, season_number, episode_ids, relative_path)
		VALUES ('ef-other', 'series-1', 1, '["ep-other"]', 'Season 01/Ep6.mkv');
	INSERT INTO subtitles (id, episode_id, relative_path, language, format)
		VALUES ('sub-other', 'ep-other', 'Other/Ep6.en.srt', 'en', 'srt');

	-- (g) movie subtitle -> never touched by the episode rewrite
	INSERT INTO subtitles (id, movie_id, relative_path, language, format)
		VALUES ('sub-movie', 'movie-1', 'movies/Alpha.en.srt', 'en', 'srt');

	-- (h) double-episode file: same directory maps to both episodes
	INSERT INTO episode_files (id, series_id, season_number, episode_ids, relative_path)
		VALUES ('ef-double', 'series-1', 1, '["ep-d1","ep-d2"]', 'Season 01/Ep7-8.mkv');
	INSERT INTO subtitles (id, episode_id, relative_path, language, format)
		VALUES ('sub-d1', 'ep-d1', 'Season 01/Ep7.en.srt', 'en', 'srt'),
		       ('sub-d2', 'ep-d2', 'Season 01/Subs/Ep8.en.srt', 'en', 'srt');
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

function pathsById(sqlite: Database.Database): Record<string, string> {
	const rows = sqlite
		.prepare(`SELECT id, relative_path FROM subtitles ORDER BY id`)
		.all() as Array<{
		id: string;
		relative_path: string;
	}>;
	return Object.fromEntries(rows.map((row) => [row.id, row.relative_path]));
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('migration v141 - subtitle search state + episode path base', () => {
	it('adds subtitles.last_checked_at and creates subtitle_search_state with its index', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v141.apply(sqlite);

		expect(getColumnNames(sqlite, 'subtitles')).toContain('last_checked_at');

		expect(getColumnNames(sqlite, 'subtitle_search_state')).toEqual([
			'owner_type',
			'owner_id',
			'requirement_key',
			'failed_attempts',
			'first_search_at',
			'last_search_at'
		]);

		// Composite primary key enforced, failed_attempts defaults to 0.
		sqlite
			.prepare(
				`INSERT INTO subtitle_search_state (owner_type, owner_id, requirement_key)
				 VALUES ('episode', 'ep-a', 'en|regular|any')`
			)
			.run();
		const row = sqlite
			.prepare(`SELECT * FROM subtitle_search_state WHERE owner_id = 'ep-a'`)
			.get() as Record<string, unknown>;
		expect(row).toMatchObject({
			owner_type: 'episode',
			owner_id: 'ep-a',
			requirement_key: 'en|regular|any',
			failed_attempts: 0,
			first_search_at: null,
			last_search_at: null
		});
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO subtitle_search_state (owner_type, owner_id, requirement_key)
					 VALUES ('episode', 'ep-a', 'en|regular|any')`
				)
				.run()
		).toThrow(/UNIQUE|PRIMARY/);

		const indexNames = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(indexNames).toContain('idx_subtitle_search_state_owner');
	});

	it('rewrites episode subtitle paths to the episode-dir base', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v141.apply(sqlite);

		expect(pathsById(sqlite)).toEqual({
			'sub-a': 'Ep.en.srt', // (a) season prefix stripped
			'sub-b': 'Ep2.en.srt', // (b) already correct
			'sub-c': 'Subs/Ep3.en.srt', // (c) only the season prefix stripped
			'sub-d': 'Season 01/Ep4.en.srt', // (d) unresolvable -> untouched
			'sub-win': 'Ep5.en.srt', // (e) Windows separators normalized + stripped
			'sub-other': 'Other/Ep6.en.srt', // (f) not under the episode dir
			'sub-movie': 'movies/Alpha.en.srt', // (g) movie row untouched
			'sub-d1': 'Ep7.en.srt', // (h) double-episode file, shared dir
			'sub-d2': 'Subs/Ep8.en.srt'
		});

		// Deprecated per-item columns and last_search_time survive the migration.
		for (const table of ['movies', 'episodes']) {
			expect(getColumnNames(sqlite, table)).toEqual(
				expect.arrayContaining([
					'failed_subtitle_attempts',
					'first_subtitle_search_at',
					'last_search_time'
				])
			);
		}
	});

	it('is idempotent: a second apply neither errors nor double-strips paths', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v141.apply(sqlite);
		const afterFirst = pathsById(sqlite);

		expect(() => migration_v141.apply(sqlite)).not.toThrow();
		expect(pathsById(sqlite)).toEqual(afterFirst);
		expect(pathsById(sqlite)['sub-a']).toBe('Ep.en.srt');

		// The transient table state is still intact.
		expect(getColumnNames(sqlite, 'subtitles')).toContain('last_checked_at');
		expect(getColumnNames(sqlite, 'subtitle_search_state')).toHaveLength(6);
	});
});

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v140 } from './140-language-system-reset.js';

const databases: Database.Database[] = [];

/**
 * Legacy (pre-v140) schema fixture. Faithful to the shipped TABLE_DEFINITIONS
 * plus the columns real databases gained through earlier migrations
 * (metadata_provider/pinned_external v085/v086, adult v096, delay_profile_id
 * v105, desired_qualities v123, metadata_language v126, quality_profile_id
 * v114, scan_mode/scan_config v115, list source/preset fields v042/v043).
 * It does NOT contain original_language, metadata_language_mode/value,
 * libraries.language_profile_id, the subtitles XOR CHECK, or any
 * language_profiles FK.
 */
const LEGACY_DDL = `
	CREATE TABLE "settings" (
		"key" text PRIMARY KEY NOT NULL,
		"value" text NOT NULL
	);

	CREATE TABLE "subtitle_settings" (
		"key" text PRIMARY KEY NOT NULL,
		"value" text NOT NULL
	);

	CREATE TABLE "language_profiles" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"languages" text NOT NULL,
		"cutoff_index" integer DEFAULT 0,
		"upgrades_allowed" integer DEFAULT true,
		"minimum_score" integer DEFAULT 60,
		"is_default" integer DEFAULT false,
		"created_at" text,
		"updated_at" text
	);

	CREATE TABLE "subtitle_providers" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"implementation" text NOT NULL
	);

	CREATE TABLE "root_folders" (
		"id" text PRIMARY KEY NOT NULL,
		"path" text NOT NULL
	);

	CREATE TABLE "scoring_profiles" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL
	);

	CREATE TABLE "delay_profiles" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL
	);

	CREATE TABLE "libraries" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"slug" text NOT NULL UNIQUE,
		"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'tv')),
		"media_sub_type" text DEFAULT 'custom' NOT NULL CHECK ("media_sub_type" IN ('standard', 'anime', 'custom')),
		"is_system" integer DEFAULT false NOT NULL,
		"system_key" text UNIQUE,
		"is_default" integer DEFAULT false NOT NULL,
		"default_root_folder_id" text,
		"default_monitored" integer DEFAULT true NOT NULL,
		"default_search_on_add" integer DEFAULT true NOT NULL,
		"default_wants_subtitles" integer DEFAULT true NOT NULL,
		"sort_order" integer DEFAULT 0 NOT NULL,
		"quality_profile_id" text,
		"scan_mode" text DEFAULT 'scheduled' NOT NULL,
		"scan_config" text,
		"created_at" text,
		"updated_at" text
	);

	CREATE TABLE "movies" (
		"id" text PRIMARY KEY NOT NULL,
		"tmdb_id" integer NOT NULL UNIQUE,
		"imdb_id" text,
		"title" text NOT NULL,
		"original_title" text,
		"year" integer,
		"overview" text,
		"poster_path" text,
		"backdrop_path" text,
		"runtime" integer,
		"genres" text,
		"metadata_provider" text DEFAULT 'auto' NOT NULL,
		"provider_refs" text,
		"pinned_external" text,
		"path" text NOT NULL,
		"library_id" text,
		"root_folder_id" text,
		"scoring_profile_id" text,
		"desired_qualities" text,
		"language_profile_id" text,
		"monitored" integer DEFAULT true,
		"minimum_availability" text DEFAULT 'released',
		"added" text,
		"has_file" integer DEFAULT false,
		"wants_subtitles" integer DEFAULT true,
		"last_search_time" text,
		"failed_subtitle_attempts" integer DEFAULT 0,
		"first_subtitle_search_at" text,
		"tmdb_collection_id" integer,
		"collection_name" text,
		"release_date" text,
		"download_release_date" text,
		"download_release_type" text,
		"digital_release_date" text,
		"physical_release_date" text,
		"availability_delay" integer NOT NULL DEFAULT 0,
		"adult" integer NOT NULL DEFAULT 0,
		"adult_source" text,
		"adult_confidence" text,
		"delay_profile_id" text,
		"metadata_language" text,
		"prefer_original_title" integer DEFAULT 0
	);

	CREATE TABLE "series" (
		"id" text PRIMARY KEY NOT NULL,
		"tmdb_id" integer NOT NULL UNIQUE,
		"tvdb_id" integer,
		"imdb_id" text,
		"title" text NOT NULL,
		"original_title" text,
		"year" integer,
		"overview" text,
		"poster_path" text,
		"backdrop_path" text,
		"status" text,
		"network" text,
		"genres" text,
		"metadata_provider" text DEFAULT 'auto' NOT NULL,
		"provider_refs" text,
		"pinned_external" text,
		"path" text NOT NULL,
		"library_id" text,
		"root_folder_id" text,
		"scoring_profile_id" text,
		"language_profile_id" text,
		"monitored" integer DEFAULT true,
		"monitor_new_items" text DEFAULT 'all',
		"monitor_specials" integer DEFAULT false,
		"season_folder" integer DEFAULT true,
		"series_type" text DEFAULT 'standard',
		"added" text,
		"episode_count" integer DEFAULT 0,
		"episode_file_count" integer DEFAULT 0,
		"wants_subtitles" integer DEFAULT true,
		"first_air_date" text,
		"adult" integer NOT NULL DEFAULT 0,
		"adult_source" text,
		"adult_confidence" text,
		"episode_group_id" text,
		"delay_profile_id" text,
		"metadata_language" text,
		"prefer_original_title" integer DEFAULT 0
	);

	CREATE TABLE "episodes" (
		"id" text PRIMARY KEY NOT NULL,
		"series_id" text NOT NULL,
		"season_number" integer NOT NULL,
		"episode_number" integer NOT NULL,
		"title" text
	);

	CREATE TABLE "movie_files" (
		"id" text PRIMARY KEY NOT NULL,
		"movie_id" text NOT NULL,
		"relative_path" text NOT NULL,
		"quality" text,
		"media_info" text
	);

	CREATE TABLE "episode_files" (
		"id" text PRIMARY KEY NOT NULL,
		"series_id" text NOT NULL,
		"season_number" integer NOT NULL,
		"relative_path" text NOT NULL,
		"media_info" text
	);

	CREATE TABLE "smart_lists" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"description" text,
		"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'tv')),
		"enabled" integer DEFAULT true,
		"filters" text NOT NULL,
		"sort_by" text DEFAULT 'popularity.desc',
		"item_limit" integer DEFAULT 100 NOT NULL,
		"exclude_in_library" integer DEFAULT true,
		"show_upgradeable_only" integer DEFAULT false,
		"excluded_tmdb_ids" text DEFAULT '[]',
		"scoring_profile_id" text,
		"auto_add_behavior" text DEFAULT 'disabled' CHECK ("auto_add_behavior" IN ('disabled', 'add_only', 'add_and_search')),
		"root_folder_id" text,
		"auto_add_monitored" integer DEFAULT true,
		"minimum_availability" text DEFAULT 'released',
		"wants_subtitles" integer DEFAULT true,
		"language_profile_id" text,
		"list_source_type" text DEFAULT 'tmdb-discover' NOT NULL,
		"external_source_config" text DEFAULT '{}' NOT NULL,
		"preset_id" text,
		"preset_provider" text,
		"preset_settings" text DEFAULT '{}' NOT NULL,
		"refresh_interval_hours" integer DEFAULT 24 NOT NULL,
		"last_refresh_time" text,
		"last_refresh_status" text,
		"last_refresh_error" text,
		"next_refresh_time" text,
		"last_external_sync_time" text,
		"external_sync_error" text,
		"cached_item_count" integer DEFAULT 0,
		"items_in_library" integer DEFAULT 0,
		"items_auto_added" integer DEFAULT 0,
		"created_at" text,
		"updated_at" text
	);

	CREATE TABLE "subtitles" (
		"id" text PRIMARY KEY NOT NULL,
		"movie_id" text,
		"episode_id" text,
		"movie_file_id" text,
		"relative_path" text NOT NULL,
		"language" text NOT NULL,
		"is_forced" integer DEFAULT false,
		"is_hearing_impaired" integer DEFAULT false,
		"format" text NOT NULL,
		"provider_id" text,
		"provider_subtitle_id" text,
		"match_score" integer,
		"is_hash_match" integer DEFAULT false,
		"size" integer,
		"sync_offset" integer DEFAULT 0,
		"was_synced" integer DEFAULT false,
		"date_added" text
	);

	CREATE TABLE "subtitle_history" (
		"id" text PRIMARY KEY NOT NULL,
		"movie_id" text,
		"episode_id" text,
		"action" text NOT NULL,
		"language" text NOT NULL,
		"provider_id" text,
		"provider_name" text,
		"provider_subtitle_id" text,
		"match_score" integer,
		"was_hash_match" integer DEFAULT false,
		"replaced_subtitle_id" text,
		"error_message" text,
		"created_at" text
	);

	CREATE TABLE "subtitle_blacklist" (
		"id" text PRIMARY KEY NOT NULL,
		"movie_id" text,
		"episode_id" text,
		"provider_id" text,
		"provider_subtitle_id" text NOT NULL,
		"reason" text,
		"language" text NOT NULL,
		"created_at" text
	);

	CREATE INDEX "idx_movies_library_id" ON "movies" ("library_id");
	CREATE INDEX "idx_series_library_id" ON "series" ("library_id");
	CREATE INDEX "idx_subtitles_movie" ON "subtitles" ("movie_id");
	CREATE INDEX "idx_subtitles_episode" ON "subtitles" ("episode_id");
`;

const SEED_SQL = `
	INSERT INTO settings (key, value) VALUES (
		'global_filters',
		'{"language":"EN-us","region":"us","include_adult":false,"genres":[]}'
	);

	INSERT INTO subtitle_settings (key, value) VALUES
		('default_language_profile_id', 'profile-a'),
		('default_fallback_language', 'en'),
		('preferred_audio_language', 'en');

	INSERT INTO language_profiles (id, name, languages, cutoff_index, upgrades_allowed, minimum_score, is_default) VALUES
		('profile-a', 'English', '[{"code":"EN","forced":true,"hearingImpaired":true,"excludeHi":false,"isCutoff":true}]', 1, 1, 60, 1),
		('profile-b', 'International', '[{"code":"eng","forced":false,"hearingImpaired":false,"excludeHi":true,"isCutoff":false}]', 2, 0, 60, 1);

	INSERT INTO subtitle_providers (id, name, implementation) VALUES ('prov-1', 'OpenSubtitles', 'opensubtitles');

	INSERT INTO libraries (
		id, name, slug, media_type, media_sub_type, is_system,
		default_monitored, default_search_on_add, default_wants_subtitles, sort_order, scan_mode
	) VALUES ('lib-1', 'Movies', 'movies', 'movie', 'standard', 1, 1, 1, 1, 0, 'scheduled');

	INSERT INTO movies (
		id, tmdb_id, title, path, library_id, language_profile_id, metadata_language,
		provider_refs, adult, metadata_provider, added
	) VALUES
		('movie-1', 101, 'Alpha', 'alpha', 'lib-1', 'profile-a', 'en-US', '{"tmdb":101}', 0, 'tmdb', '2026-01-01'),
		('movie-2', 102, 'Beta', 'beta', NULL, 'profile-zz', 'original', NULL, 0, 'tmdb', '2026-01-02'),
		('movie-3', 103, 'Gamma', 'gamma', NULL, NULL, NULL, NULL, 1, 'tmdb', '2026-01-03'),
		('movie-4', 104, 'Delta', 'delta', NULL, 'profile-b', 'garbage!!', NULL, 0, 'auto', '2026-01-04');

	INSERT INTO series (
		id, tmdb_id, title, path, library_id, language_profile_id, metadata_language, added
	) VALUES
		('series-1', 201, 'Show One', 'show-one', 'lib-1', 'profile-b', 'EN-us', '2026-01-05'),
		('series-2', 202, 'Show Two', 'show-two', NULL, NULL, NULL, '2026-01-06');

	INSERT INTO episodes (id, series_id, season_number, episode_number, title) VALUES
		('ep-1', 'series-1', 1, 1, 'Pilot');

	INSERT INTO movie_files (id, movie_id, relative_path, quality, media_info) VALUES
		('mf-1', 'movie-1', 'movies/alpha.mkv', '1080p',
			'{"containerFormat":"Matroska","audioLanguages":["eng","EN","chi"],"subtitleLanguages":["fre","","chs","pt-br"]}'),
		('mf-2', 'movie-2', 'movies/beta.mkv', '2160p', 'not-json{{');

	INSERT INTO episode_files (id, series_id, season_number, relative_path, media_info) VALUES
		('ef-1', 'series-1', 1, 'show-one/ep1.mkv', '{"subtitleLanguages":["chi"]}');

	INSERT INTO smart_lists (
		id, name, media_type, filters, item_limit, list_source_type, language_profile_id
	) VALUES ('list-1', 'Trending', 'movie', '{"sort_by":"popularity.desc"}', 100, 'tmdb-discover', 'profile-a');

	INSERT INTO subtitles (
		id, movie_id, episode_id, relative_path, language, is_forced, is_hearing_impaired, format, provider_id, date_added
	) VALUES
		('sub-1', 'movie-1', NULL, 'movies/alpha.en.srt', 'ENG', 0, 0, 'srt', 'prov-1', '2026-02-01'),
		('sub-2', 'movie-1', NULL, 'movies/alpha.fre.srt', 'fre', 0, 0, 'srt', NULL, '2026-02-02'),
		('sub-3', NULL, 'ep-1', 'show-one/ep1.chs.srt', 'chs', 0, 0, 'srt', NULL, '2026-02-03'),
		('sub-4', 'movie-2', NULL, 'movies/beta.pt-br.srt', 'pt-br', 1, 0, 'ass', NULL, '2026-02-04'),
		('sub-5', 'movie-3', NULL, 'movies/gamma.und.srt', 'und', 0, 1, 'srt', NULL, '2026-02-05'),
		('sub-6', 'movie-3', NULL, 'movies/gamma.weird.srt', 'garbage!!', 0, 0, 'srt', NULL, '2026-02-06');

	INSERT INTO subtitle_history (id, movie_id, action, language, created_at) VALUES
		('sh-1', 'movie-1', 'downloaded', 'ENG', '2026-02-07'),
		('sh-2', NULL, 'manual_upload', 'pt-br', '2026-02-08');

	INSERT INTO subtitle_blacklist (id, movie_id, provider_id, provider_subtitle_id, reason, language, created_at) VALUES
		('sb-1', 'movie-2', 'prov-1', 'ps-1', 'wrong_content', 'chs', '2026-02-09');
`;

function createLegacyDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(LEGACY_DDL);
	sqlite.exec(SEED_SQL);
	// Mirror the migration runner: applyMigration disables foreign-key enforcement
	// for the duration of a migration (it is re-enabled right afterwards), so the
	// rebuild INSERTs must not fire FK actions or validate dangling legacy refs.
	sqlite.pragma('foreign_keys = OFF');
	return sqlite;
}

function getColumnNames(sqlite: Database.Database, tableName: string): string[] {
	return (sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map(
		(column) => column.name
	);
}

function foreignKeysTo(
	sqlite: Database.Database,
	tableName: string,
	referencedTable: string
): Array<{ from: string; table: string; on_delete: string }> {
	const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as Array<{
		from: string;
		table: string;
		on_delete: string;
	}>;
	return foreignKeys
		.filter((fk) => fk.table === referencedTable)
		.map(({ from, table, on_delete }) => ({ from, table, on_delete }));
}

function countRows(sqlite: Database.Database, tableName: string): number {
	return (sqlite.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get() as { count: number })
		.count;
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('migration v140 - language system reset', () => {
	it('resets profiles, seeds language_settings, and canonicalizes legacy language data', () => {
		const sqlite = createLegacyDatabase();

		migration_v140.apply(sqlite);

		// language_profiles is empty with the v2 shape (no is_default/languages/cutoff_index)
		const profileColumns = getColumnNames(sqlite, 'language_profiles');
		expect(profileColumns).toEqual([
			'id',
			'name',
			'audio',
			'subtitles',
			'cutoff_rank',
			'minimum_score',
			'upgrades_allowed',
			'created_at',
			'updated_at'
		]);
		expect(profileColumns).not.toContain('is_default');
		expect(countRows(sqlite, 'language_profiles')).toBe(0);

		// Singleton settings row seeded from canonicalized global_filters
		const settings = sqlite
			.prepare(`SELECT * FROM language_settings WHERE id = 'singleton'`)
			.get() as Record<string, unknown>;
		expect(settings).toMatchObject({
			default_profile_id: null,
			metadata_locale: 'en-US',
			region: 'US',
			discover_original_filter: null,
			unknown_subtitle_policy: 'und',
			assumed_language: null,
			auto_sync_subtitles: 1
		});

		// global_filters was canonicalized in place, other keys preserved
		const globalFilters = JSON.parse(
			(
				sqlite.prepare(`SELECT value FROM settings WHERE key = 'global_filters'`).get() as {
					value: string;
				}
			).value
		) as Record<string, unknown>;
		expect(globalFilters.language).toBe('en-US');
		expect(globalFilters.region).toBe('US');
		expect(globalFilters.include_adult).toBe(false);
		expect(globalFilters.genres).toEqual([]);

		// Obsolete subtitle settings keys deleted, others kept
		const remainingKeys = (
			sqlite.prepare(`SELECT key FROM subtitle_settings ORDER BY key`).all() as Array<{
				key: string;
			}>
		).map((row) => row.key);
		expect(remainingKeys).toEqual(['preferred_audio_language']);

		// Every profile reference nulled (incl. the dangling 'profile-zz')
		for (const table of ['movies', 'series', 'smart_lists']) {
			const dangling = sqlite
				.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE language_profile_id IS NOT NULL`)
				.get() as { count: number };
			expect(dangling.count).toBe(0);
		}
		expect(getColumnNames(sqlite, 'libraries')).toContain('language_profile_id');

		// New media identity columns exist; original_language stays null (Phase 4 backfills)
		for (const table of ['movies', 'series']) {
			const columns = getColumnNames(sqlite, table);
			expect(columns).toEqual(
				expect.arrayContaining([
					'original_language',
					'metadata_language_mode',
					'metadata_language_value'
				])
			);
			const unassigned = sqlite
				.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE original_language IS NOT NULL`)
				.get() as { count: number };
			expect(unassigned.count).toBe(0);
		}

		// Subtitle language columns canonicalized; unmappable raw values preserved;
		// 'und' kept (never an empty string)
		const subtitleLanguages = (
			sqlite.prepare(`SELECT id, language FROM subtitles ORDER BY id`).all() as Array<{
				id: string;
				language: string;
			}>
		).reduce<Record<string, string>>((acc, row) => {
			acc[row.id] = row.language;
			return acc;
		}, {});
		expect(subtitleLanguages).toEqual({
			'sub-1': 'en',
			'sub-2': 'fr',
			'sub-3': 'zh-Hans',
			'sub-4': 'pt-BR',
			'sub-5': 'und',
			'sub-6': 'garbage!!'
		});

		const historyLanguages = (
			sqlite.prepare(`SELECT language FROM subtitle_history ORDER BY id`).all() as Array<{
				language: string;
			}>
		).map((row) => row.language);
		expect(historyLanguages).toEqual(['en', 'pt-BR']);

		const blacklistLanguage = (
			sqlite.prepare(`SELECT language FROM subtitle_blacklist WHERE id = 'sb-1'`).get() as {
				language: string;
			}
		).language;
		expect(blacklistLanguage).toBe('zh-Hans');

		// media_info language arrays canonicalized, other JSON fields preserved,
		// unparseable JSON left untouched
		const mf1 = JSON.parse(
			(
				sqlite.prepare(`SELECT media_info FROM movie_files WHERE id = 'mf-1'`).get() as {
					media_info: string;
				}
			).media_info
		) as Record<string, unknown>;
		expect(mf1).toEqual({
			containerFormat: 'Matroska',
			// 'chi' resolves to the ISO base tag 'zh'; the provider alias 'chs' to 'zh-Hans'
			audioLanguages: ['en', 'en', 'zh'],
			subtitleLanguages: ['fr', 'zh-Hans', 'pt-BR']
		});
		const mf2 = (
			sqlite.prepare(`SELECT media_info FROM movie_files WHERE id = 'mf-2'`).get() as {
				media_info: string;
			}
		).media_info;
		expect(mf2).toBe('not-json{{');
		const ef1 = JSON.parse(
			(
				sqlite.prepare(`SELECT media_info FROM episode_files WHERE id = 'ef-1'`).get() as {
					media_info: string;
				}
			).media_info
		) as Record<string, unknown>;
		expect(ef1.subtitleLanguages).toEqual(['zh']);

		// metadata_language mapped onto the mode/value pair
		const movieMetadata = (
			sqlite
				.prepare(
					`SELECT id, metadata_language_mode, metadata_language_value FROM movies ORDER BY id`
				)
				.all() as Array<{
				id: string;
				metadata_language_mode: string;
				metadata_language_value: string | null;
			}>
		).reduce<Record<string, { mode: string; value: string | null }>>((acc, row) => {
			acc[row.id] = { mode: row.metadata_language_mode, value: row.metadata_language_value };
			return acc;
		}, {});
		expect(movieMetadata).toEqual({
			'movie-1': { mode: 'explicit', value: 'en-US' },
			'movie-2': { mode: 'original', value: null },
			'movie-3': { mode: 'inherit', value: null },
			'movie-4': { mode: 'inherit', value: null }
		});
		const seriesMetadata = (
			sqlite
				.prepare(
					`SELECT id, metadata_language_mode, metadata_language_value FROM series ORDER BY id`
				)
				.all() as Array<{
				id: string;
				metadata_language_mode: string;
				metadata_language_value: string | null;
			}>
		).reduce<Record<string, { mode: string; value: string | null }>>((acc, row) => {
			acc[row.id] = { mode: row.metadata_language_mode, value: row.metadata_language_value };
			return acc;
		}, {});
		expect(seriesMetadata).toEqual({
			'series-1': { mode: 'explicit', value: 'en-US' },
			'series-2': { mode: 'inherit', value: null }
		});

		// Rebuilds kept every row and the migration-only columns' data
		expect(countRows(sqlite, 'movies')).toBe(4);
		expect(countRows(sqlite, 'series')).toBe(2);
		expect(countRows(sqlite, 'libraries')).toBe(1);
		expect(countRows(sqlite, 'smart_lists')).toBe(1);
		expect(countRows(sqlite, 'subtitles')).toBe(6);
		expect(countRows(sqlite, 'movie_files')).toBe(2);
		const movie1 = sqlite.prepare(`SELECT * FROM movies WHERE id = 'movie-1'`).get() as Record<
			string,
			unknown
		>;
		expect(movie1).toMatchObject({
			library_id: 'lib-1',
			metadata_provider: 'tmdb',
			provider_refs: '{"tmdb":101}',
			adult: 0,
			metadata_language: 'en-US'
		});
		const movie3 = sqlite.prepare(`SELECT adult FROM movies WHERE id = 'movie-3'`).get() as {
			adult: number;
		};
		expect(movie3.adult).toBe(1);
		const list1 = sqlite
			.prepare(`SELECT list_source_type, language_profile_id FROM smart_lists WHERE id = 'list-1'`)
			.get() as { list_source_type: string; language_profile_id: string | null };
		expect(list1.list_source_type).toBe('tmdb-discover');
		expect(list1.language_profile_id).toBeNull();

		// Real FKs attached (ON DELETE SET NULL) and clean integrity checks
		for (const table of ['movies', 'series', 'smart_lists', 'libraries']) {
			const profileFks = foreignKeysTo(sqlite, table, 'language_profiles');
			expect(profileFks).toEqual([
				{ from: 'language_profile_id', table: 'language_profiles', on_delete: 'SET NULL' }
			]);
		}
		const subtitlesSql = (
			sqlite
				.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='subtitles'`)
				.get() as {
				sql: string;
			}
		).sql;
		expect(subtitlesSql.replace(/\s+/g, '').toLowerCase()).toContain(
			'movie_idisnotnullandepisode_idisnull'
		);
		expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(sqlite.prepare('PRAGMA quick_check').pluck().get()).toBe('ok');

		// Indexes recreated on the rebuilt tables + new profile indexes
		const indexNames = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(indexNames).toEqual(
			expect.arrayContaining([
				'idx_movies_library_id',
				'idx_series_library_id',
				'idx_subtitles_movie',
				'idx_subtitles_episode',
				'idx_movies_language_profile',
				'idx_series_language_profile',
				'idx_smart_lists_language_profile',
				'idx_subtitles_unique_identity'
			])
		);
	});

	it('enforces the subtitle owner XOR check and the identity unique index', () => {
		const sqlite = createLegacyDatabase();
		migration_v140.apply(sqlite);

		const insertSubtitle = sqlite.prepare(
			`INSERT INTO subtitles (id, movie_id, episode_id, relative_path, language, format)
			 VALUES (?, ?, ?, ?, ?, 'srt')`
		);

		// Both owners set → rejected by the XOR CHECK
		expect(() =>
			insertSubtitle.run('sub-xor', 'movie-1', 'ep-1', 'movies/xor.srt', 'en')
		).toThrow();

		// Same owner/language/flags/path as sub-1 → rejected by the unique index
		expect(() =>
			insertSubtitle.run('sub-dup', 'movie-1', null, 'movies/alpha.en.srt', 'en')
		).toThrow();

		// A genuinely different sidecar is still accepted
		expect(() =>
			insertSubtitle.run('sub-ok', 'movie-1', null, 'movies/alpha.es.srt', 'es')
		).not.toThrow();
	});

	it('is idempotent when re-applied to an already-migrated database', () => {
		const sqlite = createLegacyDatabase();
		migration_v140.apply(sqlite);

		// Simulate post-migration usage: a v2 profile exists and is assigned.
		sqlite
			.prepare(
				`INSERT INTO language_profiles (id, name, audio, subtitles, minimum_score, upgrades_allowed)
				 VALUES ('profile-v2', 'V2', '{"preferOriginal":true,"fallbackLanguages":[]}', '[]', 70, 1)`
			)
			.run();
		sqlite
			.prepare(`UPDATE movies SET language_profile_id = 'profile-v2' WHERE id = 'movie-1'`)
			.run();

		// Simulate a later migration adding a column (m146 override) with data:
		// the rebuild must preserve it instead of dropping it.
		sqlite.prepare(`ALTER TABLE movies ADD COLUMN subtitle_requirements_override text`).run();
		const override = '[{"tag":"fr","variant":"regular","accessibility":"any"}]';
		sqlite
			.prepare(`UPDATE movies SET subtitle_requirements_override = ? WHERE id = 'movie-1'`)
			.run(override);

		expect(() => migration_v140.apply(sqlite)).not.toThrow();

		// The v2 profile and its assignment survived the re-run
		expect(
			(sqlite.prepare(`SELECT COUNT(*) AS count FROM language_profiles`).get() as { count: number })
				.count
		).toBe(1);
		const assignment = sqlite
			.prepare(
				`SELECT language_profile_id, subtitle_requirements_override FROM movies WHERE id = 'movie-1'`
			)
			.get() as {
			language_profile_id: string | null;
			subtitle_requirements_override: string | null;
		};
		expect(assignment.language_profile_id).toBe('profile-v2');
		expect(assignment.subtitle_requirements_override).toBe(override);

		// Singleton row untouched (INSERT OR IGNORE), data canonicalized once
		const settings = sqlite
			.prepare(`SELECT metadata_locale, region FROM language_settings WHERE id = 'singleton'`)
			.get() as { metadata_locale: string; region: string };
		expect(settings).toEqual({ metadata_locale: 'en-US', region: 'US' });
		expect(countRows(sqlite, 'movies')).toBe(4);
		expect(countRows(sqlite, 'subtitles')).toBe(6);
		expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	});
});

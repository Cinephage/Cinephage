import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, ensureColumn, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';
import { normalizeLanguageTag, normalizeMetadataLocale } from '../../languages/normalize.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 140: Language system reset (spec §3 + §8).
 *
 * - Drops the legacy language_profiles table (is_default + languages JSON) and
 *   recreates it with the v2 shape (audio/subtitles JSON, cutoff_rank).
 * - Creates language_settings and seeds the singleton row from global_filters.
 * - Nulls every profile reference (profile data is intentionally dropped).
 * - Deletes obsolete subtitle_settings keys.
 * - Canonicalizes stored language data in place (subtitle/history/blacklist
 *   language columns, media_info language arrays, per-item metadata_language).
 * - Adds original_language / metadata_language_mode / metadata_language_value.
 * - Rebuilds movies/series/smart_lists/libraries/subtitles to attach real FKs,
 *   the subtitle owner-XOR CHECK, and the subtitle identity unique index.
 *
 * Data rows are preserved; only profile rows are reset (spec decision table).
 */

const BATCH_SIZE = 500;

const DEFAULT_METADATA_LOCALE = 'en-US';
const DEFAULT_REGION = 'US';

const LANGUAGE_PROFILES_V2_DDL = `
	CREATE TABLE IF NOT EXISTS "language_profiles" (
		"id" text PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"audio" text NOT NULL,
		"subtitles" text NOT NULL,
		"cutoff_rank" integer,
		"minimum_score" integer DEFAULT 70 NOT NULL,
		"upgrades_allowed" integer DEFAULT true,
		"created_at" text,
		"updated_at" text
	)`;

const LANGUAGE_SETTINGS_DDL = `
	CREATE TABLE IF NOT EXISTS "language_settings" (
		"id" text PRIMARY KEY NOT NULL DEFAULT 'singleton',
		"default_profile_id" text,
		"metadata_locale" text DEFAULT 'en-US' NOT NULL,
		"region" text DEFAULT 'US' NOT NULL,
		"discover_original_filter" text,
		"unknown_subtitle_policy" text DEFAULT 'und' NOT NULL,
		"assumed_language" text,
		"auto_sync_subtitles" integer DEFAULT true NOT NULL,
		"updated_at" text
	)`;

/**
 * Rebuild DDLs. Column lists mirror schema.ts (drizzle) for each table plus
 * columns that only exist on real databases through earlier migrations
 * (metadata_provider/pinned_external from v085/v086) so a rebuild never drops
 * data. The new language_profile_id columns carry the real FK to
 * language_profiles; every other FK matches the shipped TABLE_DEFINITIONS.
 */
const MOVIES_RESET_COLUMNS = `
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
	"library_id" text REFERENCES "libraries"("id") ON DELETE SET NULL,
	"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
	"scoring_profile_id" text REFERENCES "scoring_profiles"("id") ON DELETE SET NULL,
	"desired_qualities" text,
	"language_profile_id" text REFERENCES "language_profiles"("id") ON DELETE SET NULL,
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
	"delay_profile_id" text REFERENCES "delay_profiles"("id") ON DELETE SET NULL,
	"metadata_language" text,
	"original_language" text,
	"metadata_language_mode" text DEFAULT 'inherit' NOT NULL,
	"metadata_language_value" text,
	"prefer_original_title" integer DEFAULT 0`;

const SERIES_RESET_COLUMNS = `
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
	"library_id" text REFERENCES "libraries"("id") ON DELETE SET NULL,
	"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
	"scoring_profile_id" text REFERENCES "scoring_profiles"("id") ON DELETE SET NULL,
	"language_profile_id" text REFERENCES "language_profiles"("id") ON DELETE SET NULL,
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
	"delay_profile_id" text REFERENCES "delay_profiles"("id") ON DELETE SET NULL,
	"metadata_language" text,
	"original_language" text,
	"metadata_language_mode" text DEFAULT 'inherit' NOT NULL,
	"metadata_language_value" text,
	"prefer_original_title" integer DEFAULT 0`;

const SMART_LISTS_RESET_COLUMNS = `
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
	"scoring_profile_id" text REFERENCES "scoring_profiles"("id") ON DELETE SET NULL,
	"auto_add_behavior" text DEFAULT 'disabled' CHECK ("auto_add_behavior" IN ('disabled', 'add_only', 'add_and_search')),
	"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
	"auto_add_monitored" integer DEFAULT true,
	"minimum_availability" text DEFAULT 'released',
	"wants_subtitles" integer DEFAULT true,
	"language_profile_id" text REFERENCES "language_profiles"("id") ON DELETE SET NULL,
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
	"updated_at" text`;

const LIBRARIES_RESET_COLUMNS = `
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'tv')),
	"media_sub_type" text DEFAULT 'custom' NOT NULL CHECK ("media_sub_type" IN ('standard', 'anime', 'custom')),
	"is_system" integer DEFAULT false NOT NULL,
	"system_key" text UNIQUE,
	"is_default" integer DEFAULT false NOT NULL,
	"default_root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
	"default_monitored" integer DEFAULT true NOT NULL,
	"default_search_on_add" integer DEFAULT true NOT NULL,
	"default_wants_subtitles" integer DEFAULT true NOT NULL,
	"language_profile_id" text REFERENCES "language_profiles"("id") ON DELETE SET NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"quality_profile_id" text REFERENCES "scoring_profiles"("id") ON DELETE SET NULL,
	"scan_mode" text DEFAULT 'scheduled' NOT NULL,
	"scan_config" text,
	"created_at" text,
	"updated_at" text`;

const SUBTITLES_RESET_COLUMNS = `
	"id" text PRIMARY KEY NOT NULL,
	"movie_id" text REFERENCES "movies"("id") ON DELETE CASCADE,
	"episode_id" text REFERENCES "episodes"("id") ON DELETE CASCADE,
	"movie_file_id" text REFERENCES "movie_files"("id") ON DELETE SET NULL,
	"relative_path" text NOT NULL,
	"language" text NOT NULL,
	"is_forced" integer DEFAULT false,
	"is_hearing_impaired" integer DEFAULT false,
	"format" text NOT NULL,
	"provider_id" text REFERENCES "subtitle_providers"("id") ON DELETE SET NULL,
	"provider_subtitle_id" text,
	"match_score" integer,
	"is_hash_match" integer DEFAULT false,
	"size" integer,
	"sync_offset" integer DEFAULT 0,
	"was_synced" integer DEFAULT false,
	"date_added" text,
	CHECK ((movie_id IS NOT NULL AND episode_id IS NULL) OR (movie_id IS NULL AND episode_id IS NOT NULL))`;

const SUBTITLES_UNIQUE_IDENTITY_INDEX = `
	CREATE UNIQUE INDEX IF NOT EXISTS "idx_subtitles_unique_identity" ON "subtitles" (
		ifnull(movie_id, ''),
		ifnull(episode_id, ''),
		language,
		is_forced,
		is_hearing_impaired,
		relative_path
	)`;

/** Whitespace-stripped marker of the owner-XOR CHECK in the subtitles DDL. */
const SUBTITLES_XOR_CHECK_MARKER = 'movie_idisnotnullandepisode_idisnull';

interface MetadataLanguageMapping {
	mode: 'inherit' | 'original' | 'explicit';
	value: string | null;
}

interface GlobalKeyFilters {
	metadataLocale: string;
	region: string;
}

function getColumnNames(sqlite: Database.Database, tableName: string): string[] {
	return (sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map(
		(column) => column.name
	);
}

function hasForeignKeyTo(
	sqlite: Database.Database,
	tableName: string,
	referencedTable: string
): boolean {
	if (!tableExists(sqlite, tableName)) return false;
	const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as Array<{
		table: string;
	}>;
	return foreignKeys.some((fk) => fk.table === referencedTable);
}

function getTableSql(sqlite: Database.Database, tableName: string): string {
	const row = sqlite
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
		.get(tableName) as { sql: string | null } | undefined;
	return (row?.sql ?? '').replace(/\s+/g, '').toLowerCase();
}

function hasSubtitlesXorCheck(sqlite: Database.Database): boolean {
	return getTableSql(sqlite, 'subtitles').includes(SUBTITLES_XOR_CHECK_MARKER);
}

/**
 * Rebuild a table with fresh DDL: copy the intersection of old/new columns,
 * drop the old table, rename the new one into place, and recreate every named
 * index the old table carried (auto-indexes are rebuilt with the table).
 */
function rebuildTable(sqlite: Database.Database, tableName: string, columnsSql: string): void {
	const tempName = `${tableName}__lang_reset_new`;

	const indexRows = sqlite
		.prepare(
			`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`
		)
		.all(tableName) as Array<{ name: string; sql: string }>;

	sqlite.exec(`DROP TABLE IF EXISTS "${tempName}"`);
	sqlite.exec(`CREATE TABLE "${tempName}" (\n${columnsSql}\n)`);

	const newColumns = getColumnNames(sqlite, tempName);
	const oldColumnInfo = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
		name: string;
		type: string;
	}>;
	const oldColumns = new Set(oldColumnInfo.map((column) => column.name));
	const sharedColumns = newColumns.filter((name) => oldColumns.has(name));
	if (sharedColumns.length === 0) {
		throw new Error(
			`[migration v140] No shared columns between ${tableName} and its rebuild target`
		);
	}

	// Preserve columns added by later migrations (m146 per-item overrides,
	// m147 language_shortfall, ...). A forced re-run of this migration (drift
	// repair) must never drop data owned by newer migrations.
	const extraColumns: string[] = [];
	for (const column of oldColumnInfo) {
		if (newColumns.includes(column.name)) continue;
		ensureColumn(sqlite, tempName, column.name, `"${column.name}" ${column.type || 'text'}`);
		extraColumns.push(column.name);
	}

	const columnList = [...sharedColumns, ...extraColumns].map((name) => `"${name}"`).join(', ');

	sqlite.exec(`INSERT INTO "${tempName}" (${columnList}) SELECT ${columnList} FROM "${tableName}"`);
	sqlite.exec(`DROP TABLE "${tableName}"`);
	sqlite.exec(`ALTER TABLE "${tempName}" RENAME TO "${tableName}"`);

	for (const index of indexRows) {
		// The source indexes died with the old table, so the names are free again.
		sqlite.exec(index.sql);
	}

	logger.info(
		{ table: tableName, columns: sharedColumns.length, indexes: indexRows.length },
		`[migration v140] Rebuilt ${tableName} with language system constraints`
	);
}

/** Read global_filters and canonicalize its language/region in place. */
function canonicalizeGlobalFilters(sqlite: Database.Database): GlobalKeyFilters {
	const defaults: GlobalKeyFilters = {
		metadataLocale: DEFAULT_METADATA_LOCALE,
		region: DEFAULT_REGION
	};
	if (!tableExists(sqlite, 'settings')) return defaults;

	const row = sqlite.prepare(`SELECT value FROM settings WHERE key = 'global_filters'`).get() as
		{ value: string } | undefined;
	if (!row?.value) return defaults;

	let parsed: unknown;
	try {
		parsed = JSON.parse(row.value);
	} catch {
		// Unparseable blob: leave it untouched and fall back to defaults.
		return defaults;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;

	const filters = { ...(parsed as Record<string, unknown>) };
	const canonicalLocale =
		normalizeMetadataLocale(typeof filters.language === 'string' ? filters.language : null) ??
		DEFAULT_METADATA_LOCALE;
	const regionRaw = typeof filters.region === 'string' ? filters.region.trim() : '';
	const canonicalRegion = /^[A-Za-z]{2}$/.test(regionRaw)
		? regionRaw.toUpperCase()
		: DEFAULT_REGION;

	if (filters.language !== canonicalLocale || filters.region !== canonicalRegion) {
		filters.language = canonicalLocale;
		filters.region = canonicalRegion;
		sqlite
			.prepare(`UPDATE settings SET value = ? WHERE key = 'global_filters'`)
			.run(JSON.stringify(filters));
		logger.info(
			{ language: canonicalLocale, region: canonicalRegion },
			'[migration v140] Canonicalized global_filters language/region'
		);
	}

	return { metadataLocale: canonicalLocale, region: canonicalRegion };
}

/** Drop the legacy language_profiles table and recreate it with the v2 shape. */
function resetLanguageProfiles(sqlite: Database.Database): boolean {
	if (tableExists(sqlite, 'language_profiles')) {
		const isLegacyShape =
			columnExists(sqlite, 'language_profiles', 'is_default') ||
			!columnExists(sqlite, 'language_profiles', 'audio');
		if (!isLegacyShape) return false;

		// Seed the pre-reset state: the legacy default profile id is intentionally
		// discarded (language_settings.default_profile_id stays NULL after the reset).
		if (columnExists(sqlite, 'language_profiles', 'is_default')) {
			const legacyDefault = sqlite
				.prepare(`SELECT id FROM language_profiles WHERE is_default = 1 LIMIT 1`)
				.get() as { id: string } | undefined;
			if (legacyDefault) {
				logger.info(
					{ discardedDefaultProfileId: legacyDefault.id },
					'[migration v140] Legacy default profile will be discarded (profiles reset)'
				);
			}
		}

		const indexRows = sqlite
			.prepare(
				`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = 'language_profiles' AND sql IS NOT NULL`
			)
			.all() as Array<{ sql: string }>;

		sqlite.exec(`DROP TABLE "language_profiles"`);
		sqlite.exec(LANGUAGE_PROFILES_V2_DDL);
		for (const index of indexRows) {
			sqlite.exec(index.sql);
		}
		logger.info('[migration v140] Reset language_profiles to the v2 shape (legacy rows dropped)');
		return true;
	}

	sqlite.exec(LANGUAGE_PROFILES_V2_DDL);
	logger.info('[migration v140] Created language_profiles with the v2 shape');
	return true;
}

function nullProfileReferences(sqlite: Database.Database, tables: string[]): number {
	let nulled = 0;
	for (const tableName of tables) {
		if (
			!tableExists(sqlite, tableName) ||
			!columnExists(sqlite, tableName, 'language_profile_id')
		) {
			continue;
		}
		const result = sqlite
			.prepare(
				`UPDATE "${tableName}" SET language_profile_id = NULL WHERE language_profile_id IS NOT NULL`
			)
			.run();
		nulled += result.changes;
	}
	return nulled;
}

function deleteObsoleteSubtitleSettings(sqlite: Database.Database): number {
	if (!tableExists(sqlite, 'subtitle_settings')) return 0;
	return sqlite
		.prepare(
			`DELETE FROM subtitle_settings WHERE key IN ('default_language_profile_id', 'default_fallback_language')`
		)
		.run().changes;
}

/**
 * Canonicalize a NOT NULL `language` column. Unmappable values keep their raw
 * value when non-empty; empty/whitespace values become 'und' (never '').
 */
function canonicalizeLanguageColumn(sqlite: Database.Database, tableName: string): number {
	if (!tableExists(sqlite, tableName) || !columnExists(sqlite, tableName, 'language')) return 0;

	const rows = sqlite.prepare(`SELECT id, language FROM "${tableName}"`).all() as Array<{
		id: string;
		language: string | null;
	}>;
	const update = sqlite.prepare(`UPDATE "${tableName}" SET language = ? WHERE id = ?`);
	let updated = 0;

	for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
		const pending: Array<{ id: string; language: string }> = [];
		for (const row of rows.slice(offset, offset + BATCH_SIZE)) {
			const raw = row.language ?? '';
			const canonical = normalizeLanguageTag(raw);
			const next = canonical === 'und' && raw.trim() !== '' ? raw : canonical;
			if (next !== raw) pending.push({ id: row.id, language: next });
		}
		if (pending.length === 0) continue;
		sqlite.transaction(() => {
			for (const change of pending) update.run(change.language, change.id);
		})();
		updated += pending.length;
	}

	if (updated > 0) {
		logger.info(
			{ table: tableName, updated },
			`[migration v140] Canonicalized ${tableName}.language`
		);
	}
	return updated;
}

/** Canonicalize audioLanguages/subtitleLanguages arrays inside media_info JSON. */
function canonicalizeMediaInfoLanguages(sqlite: Database.Database, tableName: string): number {
	if (!tableExists(sqlite, tableName) || !columnExists(sqlite, tableName, 'media_info')) return 0;

	const rows = sqlite
		.prepare(
			`SELECT id, media_info FROM "${tableName}" WHERE media_info IS NOT NULL AND trim(media_info) <> ''`
		)
		.all() as Array<{ id: string; media_info: string }>;
	const update = sqlite.prepare(`UPDATE "${tableName}" SET media_info = ? WHERE id = ?`);
	let updated = 0;

	for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
		const pending: Array<{ id: string; media_info: string }> = [];
		for (const row of rows.slice(offset, offset + BATCH_SIZE)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.media_info);
			} catch {
				continue; // Defensive: malformed JSON stays untouched.
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

			const mediaInfo = { ...(parsed as Record<string, unknown>) };
			let changed = false;

			for (const key of ['audioLanguages', 'subtitleLanguages'] as const) {
				const value = mediaInfo[key];
				if (!Array.isArray(value)) continue;
				const canonicalized: unknown[] = [];
				let arrayChanged = false;
				for (const entry of value) {
					if (typeof entry !== 'string') {
						canonicalized.push(entry);
						continue;
					}
					if (entry.trim() === '') {
						arrayChanged = true; // Drop empties.
						continue;
					}
					const canonical = normalizeLanguageTag(entry);
					if (canonical !== entry) arrayChanged = true;
					canonicalized.push(canonical);
				}
				if (arrayChanged) {
					mediaInfo[key] = canonicalized;
					changed = true;
				}
			}

			if (changed) pending.push({ id: row.id, media_info: JSON.stringify(mediaInfo) });
		}
		if (pending.length === 0) continue;
		sqlite.transaction(() => {
			for (const change of pending) update.run(change.media_info, change.id);
		})();
		updated += pending.length;
	}

	if (updated > 0) {
		logger.info(
			{ table: tableName, updated },
			`[migration v140] Canonicalized ${tableName}.media_info language arrays`
		);
	}
	return updated;
}

/** Map legacy metadata_language values onto the mode/value pair. */
function resolveMetadataLanguage(raw: string | null | undefined): MetadataLanguageMapping {
	const value = raw == null ? null : String(raw).trim();
	if (!value) return { mode: 'inherit', value: null };
	if (value.toLowerCase() === 'original') return { mode: 'original', value: null };
	const locale = normalizeMetadataLocale(value);
	if (locale) return { mode: 'explicit', value: locale };
	return { mode: 'inherit', value: null };
}

function buildMetadataLanguageMappings(
	sqlite: Database.Database,
	tableName: string
): Map<string, MetadataLanguageMapping> {
	const mappings = new Map<string, MetadataLanguageMapping>();
	if (!tableExists(sqlite, tableName) || !columnExists(sqlite, tableName, 'metadata_language')) {
		return mappings;
	}
	const rows = sqlite.prepare(`SELECT id, metadata_language FROM "${tableName}"`).all() as Array<{
		id: string;
		metadata_language: string | null;
	}>;
	for (const row of rows) {
		mappings.set(row.id, resolveMetadataLanguage(row.metadata_language));
	}
	return mappings;
}

function applyMetadataLanguageMappings(
	sqlite: Database.Database,
	tableName: string,
	mappings: Map<string, MetadataLanguageMapping>
): number {
	if (mappings.size === 0) return 0;
	if (
		!tableExists(sqlite, tableName) ||
		!columnExists(sqlite, tableName, 'metadata_language_mode')
	) {
		return 0;
	}

	const update = sqlite.prepare(
		`UPDATE "${tableName}" SET metadata_language_mode = ?, metadata_language_value = ? WHERE id = ?`
	);
	const entries = [...mappings.entries()];
	let updated = 0;

	for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
		const chunk = entries.slice(offset, offset + BATCH_SIZE);
		sqlite.transaction(() => {
			for (const [id, mapping] of chunk) update.run(mapping.mode, mapping.value, id);
		})();
		updated += chunk.length;
	}

	if (updated > 0) {
		logger.info(
			{ table: tableName, updated },
			`[migration v140] Mapped ${tableName}.metadata_language onto mode/value pairs`
		);
	}
	return updated;
}

/**
 * Remove exact duplicate subtitles that would violate the identity unique
 * index. Grouping mirrors the index expressions (NULL flags stay distinct).
 * Keeps the oldest row per group.
 */
function dedupeSubtitlesForUniqueIndex(sqlite: Database.Database): number {
	if (!tableExists(sqlite, 'subtitles')) return 0;

	const result = sqlite
		.prepare(
			`DELETE FROM "subtitles" WHERE id IN (
				SELECT loser.id
				FROM "subtitles" loser
				JOIN "subtitles" keeper
					ON ifnull(loser.movie_id, '') = ifnull(keeper.movie_id, '')
					AND ifnull(loser.episode_id, '') = ifnull(keeper.episode_id, '')
					AND loser.language = keeper.language
					AND loser.is_forced = keeper.is_forced
					AND loser.is_hearing_impaired = keeper.is_hearing_impaired
					AND loser.relative_path = keeper.relative_path
					AND (
						coalesce(loser.date_added, '') > coalesce(keeper.date_added, '')
						OR (
							coalesce(loser.date_added, '') = coalesce(keeper.date_added, '')
							AND loser.id > keeper.id
						)
					)
			)`
		)
		.run();

	if (result.changes > 0) {
		logger.warn(
			{ removed: result.changes },
			'[migration v140] Removed duplicate subtitle rows before adding the identity unique index'
		);
	}
	return result.changes;
}

function createLanguageProfileIndexes(sqlite: Database.Database): void {
	const targets: Array<{ table: string; index: string }> = [
		{ table: 'movies', index: 'idx_movies_language_profile' },
		{ table: 'series', index: 'idx_series_language_profile' },
		{ table: 'smart_lists', index: 'idx_smart_lists_language_profile' }
	];
	for (const { table, index } of targets) {
		if (!tableExists(sqlite, table) || !columnExists(sqlite, table, 'language_profile_id'))
			continue;
		sqlite.exec(`CREATE INDEX IF NOT EXISTS "${index}" ON "${table}" ("language_profile_id")`);
	}
}

export const migration_v140: MigrationDefinition = {
	version: 140,
	name: 'language_system_reset',
	apply: (sqlite: Database.Database) => {
		// 1+2. Seed the pre-reset state: global_filters language/region (canonicalized
		// in place) feeds the language_settings singleton below.
		const globalFilters = canonicalizeGlobalFilters(sqlite);

		// 3. Drop and recreate language_profiles with the v2 shape.
		const profilesWereReset = resetLanguageProfiles(sqlite);

		// 4. Create language_settings and seed the singleton row.
		sqlite.exec(LANGUAGE_SETTINGS_DDL);
		sqlite
			.prepare(
				`INSERT OR IGNORE INTO language_settings (id, metadata_locale, region, unknown_subtitle_policy, auto_sync_subtitles)
				 VALUES ('singleton', ?, ?, 'und', 1)`
			)
			.run(globalFilters.metadataLocale, globalFilters.region);

		// 5. Null every profile reference — profile data is intentionally dropped.
		//    Only done on an actual reset so re-runs keep valid v2 assignments.
		if (profilesWereReset) {
			const nulled = nullProfileReferences(sqlite, [
				'movies',
				'series',
				'smart_lists',
				'libraries'
			]);
			if (nulled > 0) {
				logger.info({ nulled }, '[migration v140] Nulled dangling language profile references');
			}
		}

		// 6. Delete obsolete subtitle settings keys.
		const deletedKeys = deleteObsoleteSubtitleSettings(sqlite);
		if (deletedKeys > 0) {
			logger.info({ deletedKeys }, '[migration v140] Deleted obsolete subtitle_settings keys');
		}

		// 7. Canonicalize language values in place.
		for (const tableName of ['subtitles', 'subtitle_history', 'subtitle_blacklist']) {
			canonicalizeLanguageColumn(sqlite, tableName);
		}
		for (const tableName of ['movie_files', 'episode_files']) {
			canonicalizeMediaInfoLanguages(sqlite, tableName);
		}
		const movieMappings = buildMetadataLanguageMappings(sqlite, 'movies');
		const seriesMappings = buildMetadataLanguageMappings(sqlite, 'series');

		// 8. Add the new media identity columns.
		const ensure = (table: string, column: string, definition: string) => {
			if (!tableExists(sqlite, table) || columnExists(sqlite, table, column)) return;
			sqlite.prepare(`ALTER TABLE "${table}" ADD COLUMN ${definition}`).run();
			logger.info(`[migration v140] Added ${table}.${column}`);
		};
		ensure('movies', 'original_language', '"original_language" text');
		ensure(
			'movies',
			'metadata_language_mode',
			`"metadata_language_mode" text DEFAULT 'inherit' NOT NULL`
		);
		ensure('movies', 'metadata_language_value', '"metadata_language_value" text');
		ensure('series', 'original_language', '"original_language" text');
		ensure(
			'series',
			'metadata_language_mode',
			`"metadata_language_mode" text DEFAULT 'inherit' NOT NULL`
		);
		ensure('series', 'metadata_language_value', '"metadata_language_value" text');
		ensure('libraries', 'language_profile_id', '"language_profile_id" text');
		// No original_language backfill here (Phase 4 handles it).

		applyMetadataLanguageMappings(sqlite, 'movies', movieMappings);
		applyMetadataLanguageMappings(sqlite, 'series', seriesMappings);

		// 10. Rebuild tables to attach real FKs and constraints (only when missing).
		// Backfill legacy NULL adult values before tightening the column to NOT NULL
		// below — v096 no-ops if `adult` already exists, so a pre-existing weaker
		// column definition (bare `integer`, no NOT NULL/DEFAULT) can leave real
		// NULL rows on older databases, which would otherwise fail the rebuild.
		if (tableExists(sqlite, 'movies')) {
			sqlite.exec(`UPDATE "movies" SET "adult" = 0 WHERE "adult" IS NULL`);
		}
		if (tableExists(sqlite, 'series')) {
			sqlite.exec(`UPDATE "series" SET "adult" = 0 WHERE "adult" IS NULL`);
		}
		if (tableExists(sqlite, 'movies') && !hasForeignKeyTo(sqlite, 'movies', 'language_profiles')) {
			rebuildTable(sqlite, 'movies', MOVIES_RESET_COLUMNS);
		}
		if (tableExists(sqlite, 'series') && !hasForeignKeyTo(sqlite, 'series', 'language_profiles')) {
			rebuildTable(sqlite, 'series', SERIES_RESET_COLUMNS);
		}
		if (
			tableExists(sqlite, 'smart_lists') &&
			!hasForeignKeyTo(sqlite, 'smart_lists', 'language_profiles')
		) {
			rebuildTable(sqlite, 'smart_lists', SMART_LISTS_RESET_COLUMNS);
		}
		if (
			tableExists(sqlite, 'libraries') &&
			!hasForeignKeyTo(sqlite, 'libraries', 'language_profiles')
		) {
			rebuildTable(sqlite, 'libraries', LIBRARIES_RESET_COLUMNS);
		}
		if (tableExists(sqlite, 'subtitles') && !hasSubtitlesXorCheck(sqlite)) {
			rebuildTable(sqlite, 'subtitles', SUBTITLES_RESET_COLUMNS);
		}

		// Unique identity index on subtitles (dedupe first so it cannot fail).
		dedupeSubtitlesForUniqueIndex(sqlite);
		if (tableExists(sqlite, 'subtitles')) {
			sqlite.exec(SUBTITLES_UNIQUE_IDENTITY_INDEX);
		}

		// 11. Profile assignment indexes.
		createLanguageProfileIndexes(sqlite);

		// 12. Integrity gates (report, never fail the migration).
		const fkViolations = sqlite.prepare('PRAGMA foreign_key_check').all();
		if (fkViolations.length > 0) {
			logger.warn(
				{
					count: fkViolations.length,
					sample: fkViolations.slice(0, 10)
				},
				'[migration v140] foreign_key_check reported violations after reset'
			);
		}
		const quickCheck = sqlite.prepare('PRAGMA quick_check').pluck().get() as string | undefined;
		if (quickCheck !== 'ok') {
			logger.warn({ quickCheck }, '[migration v140] quick_check reported problems');
		}
	}
};

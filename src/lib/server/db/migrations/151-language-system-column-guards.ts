import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 151: Language-system column guards.
 *
 * The language overhaul (m140-m147) shipped columns that were declared in
 * `schema.ts` / the fresh-install DDL but never backfilled by an idempotent
 * ALTER for databases created before them. The most important is
 * `episodes.wants_subtitles_override` (the episode tri-state gate), which had
 * no owning migration at all — any pre-existing `episodes` table would fail
 * every Drizzle select.
 *
 * This migration re-asserts every language-system column that later features
 * depend on. `ensureColumn` is idempotent, so re-running (including via drift
 * detection) is safe.
 */
export const migration_v151: MigrationDefinition = {
	version: 151,
	name: 'language_system_column_guards',
	apply: (sqlite: Database.Database) => {
		const columns: Array<{ table: string; column: string; definition: string }> = [
			// Episode tri-state gate (previously had no migration).
			{
				table: 'episodes',
				column: 'wants_subtitles_override',
				definition: '"wants_subtitles_override" integer'
			},
			// Per-item requirement overrides (m146).
			{
				table: 'episodes',
				column: 'subtitle_requirements_override',
				definition: '"subtitle_requirements_override" text'
			},
			{
				table: 'movies',
				column: 'subtitle_requirements_override',
				definition: '"subtitle_requirements_override" text'
			},
			{
				table: 'series',
				column: 'subtitle_requirements_override',
				definition: '"subtitle_requirements_override" text'
			},
			// Per-item language profile overrides.
			{ table: 'movies', column: 'language_profile_id', definition: '"language_profile_id" text' },
			{ table: 'series', column: 'language_profile_id', definition: '"language_profile_id" text' },
			// Metadata language override columns (m140).
			{ table: 'movies', column: 'original_language', definition: '"original_language" text' },
			{ table: 'series', column: 'original_language', definition: '"original_language" text' },
			{
				table: 'movies',
				column: 'metadata_language_mode',
				definition: `"metadata_language_mode" text NOT NULL DEFAULT 'inherit'`
			},
			{
				table: 'series',
				column: 'metadata_language_mode',
				definition: `"metadata_language_mode" text NOT NULL DEFAULT 'inherit'`
			},
			{
				table: 'movies',
				column: 'metadata_language_value',
				definition: '"metadata_language_value" text'
			},
			{
				table: 'series',
				column: 'metadata_language_value',
				definition: '"metadata_language_value" text'
			},
			// Audio-language shortfall (m147).
			{
				table: 'movies',
				column: 'language_shortfall',
				definition: '"language_shortfall" integer DEFAULT 0'
			},
			{
				table: 'series',
				column: 'language_shortfall',
				definition: '"language_shortfall" integer DEFAULT 0'
			},
			// Library / smart-list profile defaults.
			{
				table: 'libraries',
				column: 'language_profile_id',
				definition: '"language_profile_id" text'
			},
			{
				table: 'smart_lists',
				column: 'language_profile_id',
				definition: '"language_profile_id" text'
			},
			// Instance default title preference (m144).
			{
				table: 'language_settings',
				column: 'prefer_original_title',
				definition: '"prefer_original_title" integer DEFAULT 0'
			},
			// Subtitle upgrade rotation (m141).
			{ table: 'subtitles', column: 'last_checked_at', definition: '"last_checked_at" text' },
			// Media-server language stats (m143).
			{
				table: 'media_server_synced_items',
				column: 'audio_languages_raw',
				definition: '"audio_languages_raw" text'
			},
			{
				table: 'media_server_synced_items',
				column: 'subtitle_languages_raw',
				definition: '"subtitle_languages_raw" text'
			},
			// EPG i18n variants (m143).
			{ table: 'epg_programs', column: 'title_i18n', definition: '"title_i18n" text' },
			{ table: 'epg_programs', column: 'description_i18n', definition: '"description_i18n" text' },
			{ table: 'epg_programs', column: 'category_i18n', definition: '"category_i18n" text' }
		];

		let ensured = 0;
		for (const { table, column, definition } of columns) {
			if (!tableExists(sqlite, table)) continue;
			ensureColumn(sqlite, table, column, definition);
			ensured++;
		}

		logger.info(
			{ tableColumns: ensured },
			'Applied language system column guards (idempotent ensures)'
		);
	}
};

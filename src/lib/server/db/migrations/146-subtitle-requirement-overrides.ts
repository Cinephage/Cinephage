import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, ensureColumn, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Version 143: Per-item subtitle requirement overrides + inheritance repair.
 *
 * 1. Adds `subtitle_requirements_override` (JSON text, null = inherit) to
 *    movies, series, and episodes. The stored shape is the profile
 *    requirement tuple { tag, variant, accessibility }; it replaces ONLY the
 *    effective profile's requirement list (audio/score/upgrades still come
 *    from the profile chain). Episodes keep no language profile — this is a
 *    requirement-list override, not the episode-level profile the language
 *    system spec rejected.
 *
 * 2. Repairs the inheritance corruption from the 2026-09-13 language system:
 *    every add/import/task path stamped the *instance default* onto items as
 *    a per-item override (skipping the owning library entirely). Those
 *    writers are gone; this migration nulls the auto-generated overrides so
 *    library/instance defaults reach items again at read time. Overrides
 *    that differ from the instance default are kept — they can only be
 *    deliberate user choices (safe direction: wrongly nulling a deliberate
 *    override is destructive, while a surviving stale stamp is cosmetic).
 *
 * Idempotent: guarded by columnExists; the repair UPDATE only matches rows
 * whose override equals the current instance default id.
 */

const OVERRIDE_TARGETS: Array<{ table: string }> = [
	{ table: 'movies' },
	{ table: 'series' },
	{ table: 'episodes' }
];

export const migration_v146: MigrationDefinition = {
	version: 146,
	name: 'subtitle_requirement_overrides_and_inheritance_repair',
	apply: (sqlite: Database.Database) => {
		for (const { table } of OVERRIDE_TARGETS) {
			if (!tableExists(sqlite, table)) continue;
			ensureColumn(
				sqlite,
				table,
				'subtitle_requirements_override',
				'"subtitle_requirements_override" text'
			);
		}

		// Null per-item overrides that equal the instance default — those were
		// stamped automatically by add/import/task paths (see header). The
		// settings row may not exist yet, or default_profile_id may be NULL.
		const hasSettings = tableExists(sqlite, 'language_settings');
		const settingsReady =
			hasSettings && columnExists(sqlite, 'language_settings', 'default_profile_id');

		let defaultedId: string | null = null;
		if (settingsReady) {
			const row = sqlite
				.prepare(`SELECT default_profile_id FROM language_settings WHERE id = 'singleton'`)
				.get() as { default_profile_id: string | null } | undefined;
			defaultedId = row?.default_profile_id ?? null;
		}

		if (defaultedId) {
			const repair = (table: string) => {
				if (!tableExists(sqlite, table)) return 0;
				const info = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
					name: string;
				}>;
				if (!info.some((c) => c.name === 'language_profile_id')) return 0;
				const result = sqlite
					.prepare(`UPDATE "${table}" SET language_profile_id = NULL WHERE language_profile_id = ?`)
					.run(defaultedId);
				return result.changes;
			};

			const moviesRepaired = repair('movies');
			const seriesRepaired = repair('series');
			if (moviesRepaired > 0 || seriesRepaired > 0) {
				logger.info(
					{
						movies: moviesRepaired,
						series: seriesRepaired,
						profileId: defaultedId
					},
					'[migration v143] Nulled auto-stamped instance-default profile overrides'
				);
			}
		} else {
			logger.info('[migration v143] No instance default profile configured; nothing to repair');
		}
	}
};

import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';

// Module IDs that ship enabled by default. IPTV is intentionally omitted
// (out of scope for this phase - see docs/specs). Future modules add themselves
// here when they're ready to be seeded.
const DEFAULT_MODULE_IDS = ['library-streaming'] as const;

/**
 * Migration 101: Add Cinephage API subsystem tables.
 *
 * Creates two tables:
 *   - cinephage_api_config: singleton row (id = 1) holding subsystem-level config
 *     (master enable, base URL, version/commit overrides)
 *   - cinephage_api_modules: one row per feature module (moduleId, enabled,
 *     settings JSON, lastError)
 *
 * Seeds the singleton config and one row per default module. Idempotent -
 * re-running on an already-migrated database is a no-op.
 */
export const migration_v101: MigrationDefinition = {
	version: 101,
	name: 'add_cinephage_api_tables',
	apply: (sqlite) => {
		// Create cinephage_api_config (singleton)
		if (!tableExists(sqlite, 'cinephage_api_config')) {
			sqlite
				.prepare(
					`
					CREATE TABLE "cinephage_api_config" (
						"id" integer PRIMARY KEY NOT NULL DEFAULT 1 CHECK ("id" = 1),
						"enabled" integer DEFAULT 1 NOT NULL,
						"base_url" text NOT NULL DEFAULT 'https://api.cinephage.net',
						"version_override" text,
						"commit_override" text,
						"updated_at" text
					)
					`
				)
				.run();
		}

		// Create cinephage_api_modules
		if (!tableExists(sqlite, 'cinephage_api_modules')) {
			sqlite
				.prepare(
					`
					CREATE TABLE "cinephage_api_modules" (
						"module_id" text PRIMARY KEY NOT NULL,
						"enabled" integer DEFAULT 1 NOT NULL,
						"settings" text NOT NULL DEFAULT '{}',
						"last_error" text,
						"updated_at" text
					)
					`
				)
				.run();

			sqlite
				.prepare(
					`CREATE INDEX "idx_cinephage_api_modules_enabled" ON "cinephage_api_modules" ("enabled")`
				)
				.run();
		}

		// Seed singleton config row if missing
		const configRow = sqlite.prepare(`SELECT id FROM cinephage_api_config WHERE id = 1`).get();
		if (!configRow) {
			sqlite
				.prepare(
					`
					INSERT INTO cinephage_api_config (id, enabled, base_url, updated_at)
					VALUES (1, 1, 'https://api.cinephage.net', ?)
					`
				)
				.run(new Date().toISOString());
		}

		// Seed default module rows if missing
		const now = new Date().toISOString();
		const insertModule = sqlite.prepare(
			`
			INSERT OR IGNORE INTO cinephage_api_modules (module_id, enabled, settings, updated_at)
			VALUES (?, 1, '{}', ?)
			`
		);
		for (const moduleId of DEFAULT_MODULE_IDS) {
			insertModule.run(moduleId, now);
		}
	}
};

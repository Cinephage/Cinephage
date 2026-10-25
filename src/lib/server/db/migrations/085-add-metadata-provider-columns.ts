import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v085: MigrationDefinition = {
	version: 85,
	name: 'add_metadata_provider_columns',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'libraries', 'metadata_provider')) {
			sqlite
				.prepare(`ALTER TABLE libraries ADD COLUMN metadata_provider text NOT NULL DEFAULT 'auto'`)
				.run();
		}
		if (!columnExists(sqlite, 'series', 'metadata_provider')) {
			sqlite
				.prepare(`ALTER TABLE series ADD COLUMN metadata_provider text NOT NULL DEFAULT 'auto'`)
				.run();
		}
		if (!columnExists(sqlite, 'series', 'provider_refs')) {
			sqlite.prepare(`ALTER TABLE series ADD COLUMN provider_refs text`).run();
		}
		if (!columnExists(sqlite, 'series', 'pinned_external')) {
			sqlite.prepare(`ALTER TABLE series ADD COLUMN pinned_external text`).run();
		}
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_libraries_metadata_provider" ON "libraries" ("metadata_provider")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_series_metadata_provider" ON "series" ("metadata_provider")`
			)
			.run();
		logger.info('[SchemaSync] Added metadata provider columns to libraries/series (v85)');
	}
};

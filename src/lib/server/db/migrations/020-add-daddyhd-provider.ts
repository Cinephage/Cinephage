import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 20: Add DaddyHD provider support

export const migration_v020: MigrationDefinition = {
	version: 20,
	name: 'add_daddyhd_provider',
	apply: (sqlite) => {
		// Add provider column to livetv_channels_cache for DaddyHD support
		const cols = sqlite.prepare(`PRAGMA table_info(livetv_channels_cache)`).all() as {
			name: string;
		}[];
		const hasProvider = cols.some((col) => col.name === 'provider');

		if (!hasProvider) {
			sqlite
				.prepare(
					`ALTER TABLE "livetv_channels_cache" ADD COLUMN "provider" text DEFAULT 'cdnlive' CHECK ("provider" IN ('cdnlive', 'daddyhd'))`
				)
				.run();
		}

		// Create provider index
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_cache_provider" ON "livetv_channels_cache" ("provider")`
			)
			.run();

		logger.info('[SchemaSync] Added DaddyHD provider support to Live TV channels cache');
	}
};

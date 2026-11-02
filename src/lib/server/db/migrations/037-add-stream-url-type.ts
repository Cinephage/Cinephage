import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 37: Add stream_url_type to stalker_accounts

export const migration_v037: MigrationDefinition = {
	version: 37,
	name: 'add_stream_url_type',
	apply: (sqlite) => {
		// Add column for tracking URL resolution method
		// 'direct' = URLs from get_all_channels work directly
		// 'create_link' = Need to call create_link API to resolve URLs
		sqlite
			.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "stream_url_type" text DEFAULT 'unknown'`)
			.run();

		logger.info(
			'[SchemaSync] Added stream_url_type column to stalker_accounts for URL resolution tracking'
		);
	}
};

import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v072: MigrationDefinition = {
	version: 72,
	name: 'add_adaptive_subtitle_searching_columns',
	apply: (sqlite) => {
		ensureColumn(
			sqlite,
			'movies',
			'failed_subtitle_attempts',
			'"failed_subtitle_attempts" integer DEFAULT 0'
		);
		ensureColumn(sqlite, 'movies', 'first_subtitle_search_at', '"first_subtitle_search_at" text');
		ensureColumn(
			sqlite,
			'episodes',
			'failed_subtitle_attempts',
			'"failed_subtitle_attempts" integer DEFAULT 0'
		);
		ensureColumn(sqlite, 'episodes', 'first_subtitle_search_at', '"first_subtitle_search_at" text');
		logger.info('[SchemaSync] Added adaptive subtitle searching columns to movies and episodes');
	}
};

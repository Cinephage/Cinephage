import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 40: Add captcha_solver_settings table for anti-bot configuration

export const migration_v040: MigrationDefinition = {
	version: 40,
	name: 'add_captcha_solver_settings',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'captcha_solver_settings')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "captcha_solver_settings" (
					"key" text PRIMARY KEY NOT NULL,
					"value" text NOT NULL
				)`
				)
				.run();
			logger.info('[SchemaSync] Created captcha_solver_settings table');
		}
	}
};

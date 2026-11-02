import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 30: Add device parameters to stalker_accounts for proper Stalker protocol support

export const migration_v030: MigrationDefinition = {
	version: 30,
	name: 'add_stalker_device_params',
	apply: (sqlite) => {
		// Add device emulation parameters
		if (!columnExists(sqlite, 'stalker_accounts', 'serial_number')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "serial_number" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'device_id')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "device_id" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'device_id2')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "device_id2" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'model')) {
			sqlite
				.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "model" text DEFAULT 'MAG254'`)
				.run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'timezone')) {
			sqlite
				.prepare(
					`ALTER TABLE "stalker_accounts" ADD COLUMN "timezone" text DEFAULT 'Europe/London'`
				)
				.run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'token')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "token" text`).run();
		}
		// Add optional credentials
		if (!columnExists(sqlite, 'stalker_accounts', 'username')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "username" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'password')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "password" text`).run();
		}
		logger.info('[SchemaSync] Added device parameters to stalker_accounts for Stalker protocol');
	}
};

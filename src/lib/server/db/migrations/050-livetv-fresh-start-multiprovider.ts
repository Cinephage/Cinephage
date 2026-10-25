import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 50: Fresh start for Live TV with multi-provider support (Stalker, XStream, M3U)

export const migration_v050: MigrationDefinition = {
	version: 50,
	name: 'livetv_fresh_start_multiprovider',
	apply: (sqlite) => {
		logger.info('[SchemaSync] Starting fresh Live TV setup with multi-provider support');

		// Drop all existing Live TV tables (both old and new)
		const tablesToDrop = [
			// New unified tables
			'livetv_accounts',
			'livetv_channels',
			'livetv_categories',
			// Old Stalker tables
			'stalker_accounts',
			'stalker_channels',
			'stalker_categories',
			'stalker_portals',
			'portal_scan_results',
			'portal_scan_history',
			// Other Live TV tables
			'livetv_lineup',
			'livetv_lineup_backups',
			'livetv_epg_programs',
			'livetv_channel_categories',
			'livetv_cache',
			'livetv_sources',
			'livetv_events',
			'livetv_health',
			'livetv_epg_sources',
			'livetv_epg_channel_map',
			'livetv_epg_programs'
		];

		for (const table of tablesToDrop) {
			try {
				sqlite.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
				logger.info(`[SchemaSync] Dropped table: ${table}`);
			} catch {
				// Table might not exist, that's fine
			}
		}

		// Drop all related indexes
		const indexesToDrop = [
			'idx_livetv_accounts_enabled',
			'idx_livetv_accounts_type',
			'idx_livetv_channels_account',
			'idx_livetv_channels_type',
			'idx_livetv_channels_external',
			'idx_livetv_channels_name',
			'idx_livetv_channels_unique',
			'idx_livetv_categories_account',
			'idx_livetv_categories_unique',
			'idx_stalker_accounts_portal_url',
			'idx_stalker_accounts_portal_id',
			'idx_stalker_accounts_enabled',
			'idx_stalker_channels_account',
			'idx_stalker_channels_stalker_id',
			'idx_stalker_channels_category',
			'idx_stalker_categories_account',
			'idx_epg_programs_channel',
			'idx_epg_programs_channel_time',
			'idx_epg_programs_account',
			'idx_epg_programs_end',
			'idx_epg_programs_unique'
		];

		for (const index of indexesToDrop) {
			try {
				sqlite.prepare(`DROP INDEX IF EXISTS "${index}"`).run();
			} catch {
				// Index might not exist, that's fine
			}
		}

		logger.info('[SchemaSync] Creating fresh Live TV tables');

		// Create livetv_accounts
		sqlite
			.prepare(
				`
			CREATE TABLE IF NOT EXISTS "livetv_accounts" (
				"id" text PRIMARY KEY NOT NULL,
				"name" text NOT NULL,
				"provider_type" text NOT NULL,
				"enabled" integer DEFAULT 1,
		"stalker_config" text,
			"xstream_config" text,
			"m3u_config" text,
			"iptv_org_config" text,
				"playback_limit" integer,
				"channel_count" integer,
				"category_count" integer,
				"expires_at" text,
				"server_timezone" text,
				"last_tested_at" text,
				"last_test_success" integer,
				"last_test_error" text,
				"last_sync_at" text,
				"last_sync_error" text,
				"sync_status" text DEFAULT 'never',
				"last_epg_sync_at" text,
				"last_epg_sync_error" text,
				"epg_program_count" integer DEFAULT 0,
				"has_epg" integer,
				"created_at" text,
				"updated_at" text
			)
		`
			)
			.run();

		// Create livetv_channels
		sqlite
			.prepare(
				`
			CREATE TABLE IF NOT EXISTS "livetv_channels" (
				"id" text PRIMARY KEY NOT NULL,
				"account_id" text NOT NULL,
				"provider_type" text NOT NULL,
				"external_id" text NOT NULL,
				"name" text NOT NULL,
				"number" text,
				"logo" text,
				"category_id" text,
				"provider_category_id" text,
				"stalker_data" text,
				"xstream_data" text,
				"m3u_data" text,
				"epg_id" text,
				"created_at" text,
				"updated_at" text,
				FOREIGN KEY ("account_id") REFERENCES "livetv_accounts"("id") ON DELETE CASCADE
			)
		`
			)
			.run();

		// Create livetv_categories
		sqlite
			.prepare(
				`
			CREATE TABLE IF NOT EXISTS "livetv_categories" (
				"id" text PRIMARY KEY NOT NULL,
				"account_id" text NOT NULL,
				"provider_type" text NOT NULL,
				"external_id" text NOT NULL,
				"title" text NOT NULL,
				"alias" text,
				"censored" integer DEFAULT 0,
				"channel_count" integer DEFAULT 0,
				"provider_data" text,
				"created_at" text,
				"updated_at" text,
				FOREIGN KEY ("account_id") REFERENCES "livetv_accounts"("id") ON DELETE CASCADE
			)
		`
			)
			.run();

		// Create indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_accounts_enabled" ON "livetv_accounts" ("enabled")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_accounts_type" ON "livetv_accounts" ("provider_type")`
			)
			.run();

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_channels_account" ON "livetv_channels" ("account_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_channels_type" ON "livetv_channels" ("provider_type")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_channels_external" ON "livetv_channels" ("external_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_channels_name" ON "livetv_channels" ("name")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_livetv_channels_unique" ON "livetv_channels" ("account_id", "external_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_categories_account" ON "livetv_categories" ("account_id")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_livetv_categories_unique" ON "livetv_categories" ("account_id", "external_id")`
			)
			.run();

		logger.info('[SchemaSync] Fresh Live TV multi-provider setup completed successfully');
	}
};

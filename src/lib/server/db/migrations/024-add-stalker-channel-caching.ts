import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 24: Add stalker_categories and stalker_channels tables for channel caching

export const migration_v024: MigrationDefinition = {
	version: 24,
	name: 'add_stalker_channel_caching',
	apply: (sqlite) => {
		// Add sync tracking columns to stalker_accounts
		if (!columnExists(sqlite, 'stalker_accounts', 'last_sync_at')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "last_sync_at" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'last_sync_error')) {
			sqlite.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "last_sync_error" text`).run();
		}
		if (!columnExists(sqlite, 'stalker_accounts', 'sync_status')) {
			sqlite
				.prepare(`ALTER TABLE "stalker_accounts" ADD COLUMN "sync_status" text DEFAULT 'never'`)
				.run();
		}

		// Create stalker_categories table
		if (!tableExists(sqlite, 'stalker_categories')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "stalker_categories" (
					"id" text PRIMARY KEY NOT NULL,
					"account_id" text NOT NULL REFERENCES "stalker_accounts"("id") ON DELETE CASCADE,
					"stalker_id" text NOT NULL,
					"title" text NOT NULL,
					"alias" text,
					"censored" integer DEFAULT 0,
					"channel_count" integer DEFAULT 0,
					"created_at" text,
					"updated_at" text
				)`
				)
				.run();

			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_stalker_categories_account" ON "stalker_categories" ("account_id")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_stalker_categories_unique" ON "stalker_categories" ("account_id", "stalker_id")`
				)
				.run();

			logger.info('[SchemaSync] Added stalker_categories table');
		}

		// Create stalker_channels table
		if (!tableExists(sqlite, 'stalker_channels')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "stalker_channels" (
					"id" text PRIMARY KEY NOT NULL,
					"account_id" text NOT NULL REFERENCES "stalker_accounts"("id") ON DELETE CASCADE,
					"stalker_id" text NOT NULL,
					"name" text NOT NULL,
					"number" text,
					"logo" text,
					"category_id" text REFERENCES "stalker_categories"("id") ON DELETE SET NULL,
					"stalker_genre_id" text,
					"cmd" text NOT NULL,
					"tv_archive" integer DEFAULT 0,
					"archive_duration" integer DEFAULT 0,
					"created_at" text,
					"updated_at" text
				)`
				)
				.run();

			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_stalker_channels_account" ON "stalker_channels" ("account_id")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_stalker_channels_category" ON "stalker_channels" ("category_id")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE INDEX IF NOT EXISTS "idx_stalker_channels_name" ON "stalker_channels" ("name")`
				)
				.run();
			sqlite
				.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_stalker_channels_unique" ON "stalker_channels" ("account_id", "stalker_id")`
				)
				.run();

			logger.info('[SchemaSync] Added stalker_channels table');
		}

		logger.info('[SchemaSync] Added channel caching tables for Live TV');
	}
};

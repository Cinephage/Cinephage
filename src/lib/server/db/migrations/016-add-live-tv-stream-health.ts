import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 16: Add Live TV stream health tracking table

export const migration_v016: MigrationDefinition = {
	version: 16,
	name: 'add_live_tv_stream_health',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "livetv_stream_health" (
		"channel_id" text PRIMARY KEY NOT NULL,
		"health" text DEFAULT 'unknown' NOT NULL CHECK ("health" IN ('healthy', 'warning', 'failing', 'offline', 'unknown')),
		"api_status" text DEFAULT 'unknown' CHECK ("api_status" IN ('online', 'offline', 'unknown')),
		"api_status_changed_at" text,
		"last_validation_result" text CHECK ("last_validation_result" IN ('success', 'failed', 'timeout', 'error')),
		"last_validation_at" text,
		"last_validation_error" text,
		"validation_response_time_ms" integer,
		"consecutive_failures" integer DEFAULT 0 NOT NULL,
		"total_validations" integer DEFAULT 0 NOT NULL,
		"total_failures" integer DEFAULT 0 NOT NULL,
		"recent_failures" text DEFAULT '[]',
		"last_success" text,
		"last_failure" text,
		"avg_response_time" integer,
		"current_viewers" integer DEFAULT 0,
		"peak_viewers" integer DEFAULT 0,
		"peak_viewers_at" text,
		"created_at" text,
		"updated_at" text
	)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_health_status" ON "livetv_stream_health" ("health")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_livetv_health_api_status" ON "livetv_stream_health" ("api_status")`
			)
			.run();
		logger.info('[SchemaSync] Added livetv_stream_health table for stream health tracking');
	}
};

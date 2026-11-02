import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

const EPISODE_ID_REFERENCE_TABLES = [
	'monitoring_history',
	'subtitles',
	'subtitle_history',
	'subtitle_blacklist'
];

const EPISODE_IDS_JSON_TABLES = [
	'episode_files',
	'download_queue',
	'download_history',
	'blocklist',
	'pending_releases',
	'nzb_stream_mounts'
];

function remapJsonEpisodeIds(value: unknown, duplicateToKept: Map<string, string>): string | null {
	if (typeof value !== 'string' || value.length === 0) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed)) {
		return null;
	}

	let changed = false;
	const remapped: string[] = [];
	for (const item of parsed) {
		if (typeof item !== 'string') {
			continue;
		}
		const mapped = duplicateToKept.get(item) ?? item;
		if (mapped !== item) {
			changed = true;
		}
		if (!remapped.includes(mapped)) {
			remapped.push(mapped);
		}
	}

	return changed ? JSON.stringify(remapped) : null;
}

function remapDuplicateEpisodeReferences(
	sqlite: Parameters<MigrationDefinition['apply']>[0],
	duplicateToKept: Map<string, string>
): void {
	if (duplicateToKept.size === 0) {
		return;
	}

	for (const tableName of EPISODE_ID_REFERENCE_TABLES) {
		if (!tableExists(sqlite, tableName) || !columnExists(sqlite, tableName, 'episode_id')) {
			continue;
		}
		const update = sqlite.prepare(
			`UPDATE "${tableName}" SET "episode_id" = ? WHERE "episode_id" = ?`
		);
		for (const [duplicateId, keptId] of duplicateToKept) {
			update.run(keptId, duplicateId);
		}
	}

	for (const tableName of EPISODE_IDS_JSON_TABLES) {
		if (!tableExists(sqlite, tableName) || !columnExists(sqlite, tableName, 'episode_ids')) {
			continue;
		}

		const rows = sqlite
			.prepare(
				`SELECT rowid, "episode_ids" AS episodeIds FROM "${tableName}" WHERE "episode_ids" IS NOT NULL`
			)
			.all() as Array<{ rowid: number; episodeIds: string | null }>;
		const update = sqlite.prepare(`UPDATE "${tableName}" SET "episode_ids" = ? WHERE rowid = ?`);

		for (const row of rows) {
			const remapped = remapJsonEpisodeIds(row.episodeIds, duplicateToKept);
			if (remapped !== null) {
				update.run(remapped, row.rowid);
			}
		}
	}
}

function dedupeSeasonAndEpisodeNumbers(sqlite: Parameters<MigrationDefinition['apply']>[0]): void {
	if (tableExists(sqlite, 'seasons')) {
		const duplicateSeasons = sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM (
					SELECT 1 FROM "seasons"
					GROUP BY "series_id", "season_number"
					HAVING COUNT(*) > 1
				 )`
			)
			.get() as { count: number };

		if (duplicateSeasons.count > 0) {
			if (tableExists(sqlite, 'episodes') && columnExists(sqlite, 'episodes', 'season_id')) {
				sqlite
					.prepare(
						`UPDATE "episodes"
					 SET "season_id" = (
						SELECT "kept_seasons"."id"
						FROM "seasons" AS "kept_seasons"
						WHERE "kept_seasons"."series_id" = "episodes"."series_id"
							AND "kept_seasons"."season_number" = "episodes"."season_number"
						ORDER BY "kept_seasons".rowid
						LIMIT 1
					 )
					 WHERE "season_id" IN (
						SELECT "duplicate_seasons"."id"
						FROM "seasons" AS "duplicate_seasons"
						WHERE "duplicate_seasons".rowid NOT IN (
							SELECT MIN(rowid) FROM "seasons" GROUP BY "series_id", "season_number"
						)
					 )`
					)
					.run();
			}
			sqlite
				.prepare(
					`DELETE FROM "seasons"
					 WHERE rowid NOT IN (
						SELECT MIN(rowid) FROM "seasons" GROUP BY "series_id", "season_number"
					 )`
				)
				.run();
			logger.info('[Migration v090] Removed duplicate season rows before creating unique index');
		}
	}

	if (tableExists(sqlite, 'episodes')) {
		const duplicateEpisodes = sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM (
					SELECT 1 FROM "episodes"
					GROUP BY "series_id", "season_number", "episode_number"
					HAVING COUNT(*) > 1
				 )`
			)
			.get() as { count: number };

		if (duplicateEpisodes.count > 0) {
			const duplicateRows = sqlite
				.prepare(
					`SELECT "duplicates"."id" AS duplicateId, "kept"."id" AS keptId
					 FROM "episodes" AS "duplicates"
					 JOIN "episodes" AS "kept"
						ON "kept"."series_id" = "duplicates"."series_id"
						AND "kept"."season_number" = "duplicates"."season_number"
						AND "kept"."episode_number" = "duplicates"."episode_number"
						AND "kept".rowid = (
							SELECT MIN("grouped".rowid)
							FROM "episodes" AS "grouped"
							WHERE "grouped"."series_id" = "duplicates"."series_id"
								AND "grouped"."season_number" = "duplicates"."season_number"
								AND "grouped"."episode_number" = "duplicates"."episode_number"
						)
					 WHERE "duplicates".rowid NOT IN (
						SELECT MIN(rowid)
						FROM "episodes"
						GROUP BY "series_id", "season_number", "episode_number"
					 )`
				)
				.all() as Array<{ duplicateId: string; keptId: string }>;
			const duplicateToKept = new Map(
				duplicateRows.map((row) => [row.duplicateId, row.keptId] as const)
			);
			remapDuplicateEpisodeReferences(sqlite, duplicateToKept);

			sqlite
				.prepare(
					`DELETE FROM "episodes"
					 WHERE rowid NOT IN (
						SELECT MIN(rowid)
						FROM "episodes"
						GROUP BY "series_id", "season_number", "episode_number"
					 )`
				)
				.run();
			logger.info('[Migration v090] Removed duplicate episode rows before creating unique index');
		}
	}
}

export const migration_v090: MigrationDefinition = {
	version: 90,
	name: 'add_library_jobs',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'library_jobs')) {
			sqlite
				.prepare(
					`CREATE TABLE "library_jobs" (
						"id" text PRIMARY KEY NOT NULL,
						"type" text NOT NULL,
						"status" text DEFAULT 'queued' NOT NULL,
						"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
						"parent_job_id" text,
						"dedupe_key" text,
						"phase" text DEFAULT 'queued' NOT NULL,
						"progress_current" integer DEFAULT 0 NOT NULL,
						"progress_total" integer,
						"files_found" integer DEFAULT 0 NOT NULL,
						"files_processed" integer DEFAULT 0 NOT NULL,
						"files_added" integer DEFAULT 0 NOT NULL,
						"files_updated" integer DEFAULT 0 NOT NULL,
						"files_removed" integer DEFAULT 0 NOT NULL,
						"unmatched_count" integer DEFAULT 0 NOT NULL,
						"error_message" text,
						"cancel_requested" integer DEFAULT false NOT NULL,
						"metadata" text,
						"started_at" text,
						"completed_at" text,
						"created_at" text,
						"updated_at" text
					)`
				)
				.run();
			logger.info('[Migration v090] Created library_jobs table');
		}

		if (!tableExists(sqlite, 'library_job_items')) {
			sqlite
				.prepare(
					`CREATE TABLE "library_job_items" (
						"id" text PRIMARY KEY NOT NULL,
						"job_id" text NOT NULL REFERENCES "library_jobs"("id") ON DELETE CASCADE,
						"status" text DEFAULT 'queued' NOT NULL,
						"kind" text NOT NULL,
						"path" text,
						"root_folder_id" text REFERENCES "root_folders"("id") ON DELETE SET NULL,
						"media_type" text,
						"attempts" integer DEFAULT 0 NOT NULL,
						"error_message" text,
						"metadata" text,
						"created_at" text,
						"updated_at" text
					)`
				)
				.run();
			logger.info('[Migration v090] Created library_job_items table');
		}

		for (const tableName of ['movie_files', 'episode_files', 'unmatched_files']) {
			if (!columnExists(sqlite, tableName, 'last_seen_scan_id')) {
				sqlite.prepare(`ALTER TABLE "${tableName}" ADD COLUMN "last_seen_scan_id" text`).run();
				logger.info(`[Migration v090] Added last_seen_scan_id column to ${tableName}`);
			}
		}

		dedupeSeasonAndEpisodeNumbers(sqlite);

		for (const indexSql of [
			`CREATE INDEX IF NOT EXISTS "idx_library_jobs_status_created" ON "library_jobs" ("status", "created_at")`,
			`CREATE INDEX IF NOT EXISTS "idx_library_jobs_type_status" ON "library_jobs" ("type", "status")`,
			`CREATE INDEX IF NOT EXISTS "idx_library_jobs_root_status" ON "library_jobs" ("root_folder_id", "status")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_library_jobs_active_dedupe" ON "library_jobs" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL AND "status" IN ('queued','running')`,
			`CREATE INDEX IF NOT EXISTS "idx_library_job_items_job_status" ON "library_job_items" ("job_id", "status")`,
			`CREATE INDEX IF NOT EXISTS "idx_library_job_items_path" ON "library_job_items" ("path")`,
			`CREATE INDEX IF NOT EXISTS "idx_movies_root_folder" ON "movies" ("root_folder_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_series_root_folder" ON "series" ("root_folder_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_unmatched_root_folder" ON "unmatched_files" ("root_folder_id")`,
			`CREATE INDEX IF NOT EXISTS "idx_unmatched_media_discovered" ON "unmatched_files" ("media_type", "discovered_at")`,
			`CREATE INDEX IF NOT EXISTS "idx_scan_history_root_status_started" ON "library_scan_history" ("root_folder_id", "status", "started_at")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_seasons_unique_number" ON "seasons" ("series_id", "season_number")`,
			`CREATE UNIQUE INDEX IF NOT EXISTS "idx_episodes_unique_number" ON "episodes" ("series_id", "season_number", "episode_number")`
		]) {
			sqlite.prepare(indexSql).run();
		}
		logger.info('[Migration v090] Created library job indexes');
	}
};

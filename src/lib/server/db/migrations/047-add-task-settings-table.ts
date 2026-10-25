import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 47: Add task_settings table for per-task configuration

export const migration_v047: MigrationDefinition = {
	version: 47,
	name: 'add_task_settings_table',
	apply: (sqlite) => {
		// Create task_settings table
		sqlite
			.prepare(
				`
				CREATE TABLE IF NOT EXISTS "task_settings" (
					"id" text PRIMARY KEY NOT NULL,
					"enabled" integer DEFAULT 1 NOT NULL,
					"interval_hours" real,
					"min_interval_hours" real DEFAULT 0.25 NOT NULL,
					"last_run_at" text,
					"next_run_at" text,
					"created_at" text,
					"updated_at" text
				)
			`
			)
			.run();

		// Create indexes
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_task_settings_enabled" ON "task_settings" ("enabled")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_task_settings_next_run" ON "task_settings" ("next_run_at")`
			)
			.run();

		// Migrate existing settings from monitoring_settings table
		const defaultSettings: Record<string, { interval: number; minInterval: number }> = {
			missing: { interval: 24, minInterval: 0.25 },
			upgrade: { interval: 168, minInterval: 0.25 },
			newEpisode: { interval: 1, minInterval: 0.25 },
			cutoffUnmet: { interval: 24, minInterval: 0.25 },
			pendingRelease: { interval: 0.25, minInterval: 0.25 },
			missingSubtitles: { interval: 6, minInterval: 0.25 },
			subtitleUpgrade: { interval: 24, minInterval: 0.25 },
			smartListRefresh: { interval: 1, minInterval: 0.25 }
		};

		const now = new Date().toISOString();

		// Get existing intervals from monitoring_settings
		const existingSettings = sqlite
			.prepare(`SELECT key, value FROM monitoring_settings WHERE key LIKE '%_interval_hours'`)
			.all() as Array<{ key: string; value: string }>;

		const settingMap: Record<string, string> = {
			missing_search_interval_hours: 'missing',
			upgrade_search_interval_hours: 'upgrade',
			new_episode_check_interval_hours: 'newEpisode',
			cutoff_unmet_search_interval_hours: 'cutoffUnmet',
			missing_subtitles_interval_hours: 'missingSubtitles',
			subtitle_upgrade_interval_hours: 'subtitleUpgrade'
		};

		// Insert default settings
		for (const [taskId, config] of Object.entries(defaultSettings)) {
			// Check if we have a custom value from monitoring_settings
			let intervalHours = config.interval;
			const settingKey = Object.entries(settingMap).find(([, v]) => v === taskId)?.[0];
			if (settingKey) {
				const existing = existingSettings.find((s) => s.key === settingKey);
				if (existing) {
					const parsed = parseFloat(existing.value);
					if (!isNaN(parsed) && parsed >= config.minInterval) {
						intervalHours = parsed;
					}
				}
			}

			// Calculate next_run_at based on interval (set to past so it runs soon)
			const lastRunAt = new Date(Date.now() - intervalHours * 60 * 60 * 1000).toISOString();
			const nextRunAt = new Date(Date.now()).toISOString();

			sqlite
				.prepare(
					`
					INSERT OR REPLACE INTO task_settings (id, enabled, interval_hours, min_interval_hours, last_run_at, next_run_at, created_at, updated_at)
					VALUES (?, 1, ?, ?, ?, ?, ?, ?)
					`
				)
				.run(taskId, intervalHours, config.minInterval, lastRunAt, nextRunAt, now, now);
		}

		logger.info('[SchemaSync] Created task_settings table with default settings');
	}
};

import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v115: MigrationDefinition = {
	version: 115,
	name: 'add_scan_mode_to_libraries',
	apply: (sqlite) => {
		try {
			sqlite
				.prepare(`ALTER TABLE "libraries" ADD COLUMN "scan_mode" text NOT NULL DEFAULT 'scheduled'`)
				.run();
			sqlite.prepare(`ALTER TABLE "libraries" ADD COLUMN "scan_config" text`).run();

			// Migrate watch_enabled: if watch was enabled in librarySettings,
			// set scan_mode to 'watch' with default debounce
			const watchSetting = sqlite
				.prepare(`SELECT "value" FROM "library_settings" WHERE "key" = 'watch_enabled'`)
				.get() as { value: string } | undefined;
			if (watchSetting?.value === 'true') {
				sqlite
					.prepare(`UPDATE "libraries" SET "scan_mode" = 'watch', "scan_config" = ?`)
					.run(JSON.stringify({ debounceSeconds: 5 }));
			}

			// Migrate scan_interval_hours into scan_config for scheduled mode
			const intervalSetting = sqlite
				.prepare(`SELECT "value" FROM "library_settings" WHERE "key" = 'scan_interval_hours'`)
				.get() as { value: string } | undefined;
			if (intervalSetting?.value) {
				sqlite
					.prepare(`UPDATE "libraries" SET "scan_config" = ? WHERE "scan_mode" = 'scheduled'`)
					.run(JSON.stringify({ intervalMinutes: parseInt(intervalSetting.value, 10) * 60 }));
			}

			logger.info('[migration v115] scan_mode + scan_config columns added to libraries');
		} catch (e) {
			logger.info(
				{ err: e instanceof Error ? e.message : String(e) },
				'[migration v115] Columns may already exist, skipping'
			);
		}
	}
};

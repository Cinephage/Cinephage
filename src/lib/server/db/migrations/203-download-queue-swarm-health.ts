import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';

/**
 * Version 203: dead-torrent detection.
 *
 * - download_queue.swarm_health (JSON): what the dead-torrent check last saw
 *   (seeds, availability, when bytes last went up, consecutive bad checks).
 *   Persisted so a restart does not reset the clock or the strikes.
 * - dead_download_searches: when a movie or episode was last searched
 *   automatically after its download died, so that search runs at most once
 *   per item per day.
 */
export const migration_v203: MigrationDefinition = {
	version: 203,
	name: 'download_queue_swarm_health',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'download_queue', 'swarm_health')) {
			sqlite.prepare(`ALTER TABLE "download_queue" ADD COLUMN "swarm_health" text`).run();
		}
		if (!tableExists(sqlite, 'dead_download_searches')) {
			sqlite
				.prepare(
					`CREATE TABLE "dead_download_searches" (
						"target_key" text PRIMARY KEY NOT NULL,
						"searched_at" text NOT NULL
					)`
				)
				.run();
		}
	}
};

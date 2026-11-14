import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 173: movies.consecutive_failure_count, episodes.consecutive_failure_count.
 *
 * Counts consecutive failed grab/import attempts for an item, independent of
 * which release was tried - the existing failed-download cooldown and
 * release blocklist both operate per-release, so neither stops an item from
 * being retried forever against a new release every cycle. Incremented in
 * DownloadMonitorService.markFailed, reset to 0 on a successful import.
 * NULL/0 for every existing row means no behavior change until an item
 * actually starts failing.
 *
 * Numbered 173 (not 172) because 172 was taken on origin/dev by an
 * independently-developed, since-discarded search_state table.
 */
export const migration_v173: MigrationDefinition = {
	version: 173,
	name: 'consecutive_failure_count',
	apply: (sqlite) => {
		ensureColumn(
			sqlite,
			'movies',
			'consecutive_failure_count',
			'"consecutive_failure_count" integer not null default 0'
		);
		ensureColumn(
			sqlite,
			'episodes',
			'consecutive_failure_count',
			'"consecutive_failure_count" integer not null default 0'
		);
	}
};

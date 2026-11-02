import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureColumn } from '../migration-helpers.js';

/**
 * Version 164: Add `transferMode` column to `download_queue` and `download_history`.
 *
 * Persists the executed transfer mode ('hardlink' | 'copy' | 'move' | 'symlink')
 * so it can be displayed in the Activity detail UI.
 *
 * Fixes #597 (silent fallback from hardlink to copy).
 */
export const migration_v164: MigrationDefinition = {
	version: 164,
	name: 'transfer_mode',
	apply: (sqlite) => {
		ensureColumn(sqlite, 'download_queue', 'transfer_mode', '"transfer_mode" text');
		ensureColumn(sqlite, 'download_history', 'transfer_mode', '"transfer_mode" text');
	}
};

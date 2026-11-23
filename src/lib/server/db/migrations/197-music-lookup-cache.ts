import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 197: `music_lookup_cache`.
 *
 * MusicBrainz allows one request per second, and a playlist import spends one
 * request per album plus one per unmatched song. The same playlist is resolved
 * again by every re-import and, once smart lists exist, by every refresh, so
 * the answers have to outlive the request. Misses are cached too — otherwise
 * ten unmatchable tracks cost ten searches on every single refresh.
 */
export const migration_v197: MigrationDefinition = {
	version: 197,
	name: 'music_lookup_cache',
	apply: (sqlite) => {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS "music_lookup_cache" (
				"key" text PRIMARY KEY NOT NULL,
				"payload" text NOT NULL,
				"fetched_at" text NOT NULL
			)
		`);
	}
};

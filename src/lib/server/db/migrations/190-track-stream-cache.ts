import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 190: `track_stream_cache`.
 *
 * The resolver keeps a resolved provider URL in memory for half an hour, which
 * a restart throws away — so the first track of every album paid the full
 * yt-dlp cost again after each deploy. The URL itself is valid for hours; this
 * table keeps it, keyed to the track and with its own expiry, so playback can
 * skip the provider until the link actually dies.
 *
 * One row per played track, overwritten in place. Nothing is stored for a local
 * file: that path is a stat() and needs no cache.
 */
export const migration_v190: MigrationDefinition = {
	version: 190,
	name: 'track_stream_cache',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "track_stream_cache" (
					"track_id" text PRIMARY KEY NOT NULL REFERENCES "tracks"("id") ON DELETE CASCADE,
					"url" text NOT NULL,
					"content_type" text NOT NULL,
					"expires_at" integer NOT NULL
				)`
			)
			.run();

		sqlite
			.prepare(`CREATE INDEX IF NOT EXISTS "idx_track_stream_cache_expiry" ON "track_stream_cache" ("expires_at")`)
			.run();
	}
};

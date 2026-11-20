import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 189: `tracks.stream_video_id`.
 *
 * Playback used to run a YouTube search on every cold track, which is what the
 * few-seconds pause before a song is. The chosen upload is now remembered, so a
 * replay resolves the same video directly and the album's other tracks can be
 * warmed ahead of the click.
 *
 * Additive ALTER — no table rebuild, no FK (the id belongs to an external site).
 */
export const migration_v189: MigrationDefinition = {
	version: 189,
	name: 'track_stream_video',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("tracks")`).all() as Array<{ name: string }>;

		if (!columns.some((column) => column.name === 'stream_video_id')) {
			sqlite.prepare(`ALTER TABLE "tracks" ADD COLUMN "stream_video_id" text`).run();
		}
	}
};

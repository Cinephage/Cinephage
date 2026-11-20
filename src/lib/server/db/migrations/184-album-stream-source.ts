import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 184: `albums.stream_source`.
 *
 * A stream grab leaves no file and no queue row — there is no download client
 * to track — so the album needs a marker of its own. Null means "normal
 * acquisition"; a non-null value names the indexer that serves it. Cleared by
 * a download grab, which makes the newest grab the source of truth.
 *
 * Additive ALTER — no table rebuild.
 */
export const migration_v184: MigrationDefinition = {
	version: 184,
	name: 'album_stream_source',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("albums")`).all() as Array<{ name: string }>;

		if (!columns.some((column) => column.name === 'stream_source')) {
			sqlite.prepare(`ALTER TABLE "albums" ADD COLUMN "stream_source" text`).run();
		}
	}
};

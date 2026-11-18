import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 183: `download_clients.category_map`.
 *
 * A download client needs one category per media kind. Two columns existed for
 * two kinds; music would make three and books four, so the kinds that arrive
 * after video go into a JSON map instead and the movie/tv columns stay the
 * source of truth for video.
 *
 * The backfill copies the existing columns so nothing changes for an install
 * that never sets a music category.
 *
 * Additive ALTER plus a data update — no table rebuild.
 */
export const migration_v183: MigrationDefinition = {
	version: 183,
	name: 'download_client_category_map',
	apply: (sqlite) => {
		const columns = sqlite.prepare(`PRAGMA table_info("download_clients")`).all() as Array<{
			name: string;
		}>;

		if (!columns.some((column) => column.name === 'category_map')) {
			sqlite.prepare(`ALTER TABLE "download_clients" ADD COLUMN "category_map" text`).run();
		}

		sqlite
			.prepare(
				`UPDATE "download_clients"
				 SET "category_map" = json_object(
					'movie', COALESCE("movie_category", 'movies'),
					'tv', COALESCE("tv_category", 'tv')
				 )
				 WHERE "category_map" IS NULL`
			)
			.run();
	}
};

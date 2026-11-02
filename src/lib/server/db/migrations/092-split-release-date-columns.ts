import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v092: MigrationDefinition = {
	version: 92,
	name: 'split_release_date_columns',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'movies')) return;

		if (!columnExists(sqlite, 'movies', 'digital_release_date')) {
			sqlite.prepare(`ALTER TABLE "movies" ADD COLUMN "digital_release_date" text`).run();
			logger.info('[Migration v092] Added digital_release_date column to movies');
		}

		if (!columnExists(sqlite, 'movies', 'physical_release_date')) {
			sqlite.prepare(`ALTER TABLE "movies" ADD COLUMN "physical_release_date" text`).run();
			logger.info('[Migration v092] Added physical_release_date column to movies');
		}

		if (!columnExists(sqlite, 'movies', 'availability_delay')) {
			sqlite
				.prepare(`ALTER TABLE "movies" ADD COLUMN "availability_delay" integer NOT NULL DEFAULT 0`)
				.run();
			logger.info('[Migration v092] Added availability_delay column to movies');
		}

		sqlite
			.prepare(
				`UPDATE "movies" SET "digital_release_date" = "download_release_date" WHERE "download_release_type" = 'digital' AND "digital_release_date" IS NULL`
			)
			.run();
		sqlite
			.prepare(
				`UPDATE "movies" SET "physical_release_date" = "download_release_date" WHERE "download_release_type" = 'physical' AND "physical_release_date" IS NULL`
			)
			.run();
		logger.info('[Migration v092] Backfilled release date columns');

		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_movies_digital_release_date" ON "movies" ("digital_release_date")`
			)
			.run();
		sqlite
			.prepare(
				`CREATE INDEX IF NOT EXISTS "idx_movies_physical_release_date" ON "movies" ("physical_release_date")`
			)
			.run();
		logger.info('[Migration v092] Created release date indexes');
	}
};

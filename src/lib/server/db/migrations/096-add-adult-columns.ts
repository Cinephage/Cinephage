import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v096: MigrationDefinition = {
	version: 96,
	name: 'add_adult_columns',
	apply: (sqlite) => {
		if (tableExists(sqlite, 'movies')) {
			if (!columnExists(sqlite, 'movies', 'adult')) {
				sqlite.prepare(`ALTER TABLE "movies" ADD COLUMN "adult" integer NOT NULL DEFAULT 0`).run();
				logger.info('[Migration v096] Added adult column to movies');
			}
			if (!columnExists(sqlite, 'movies', 'adult_source')) {
				sqlite.prepare(`ALTER TABLE "movies" ADD COLUMN "adult_source" text`).run();
				logger.info('[Migration v096] Added adult_source column to movies');
			}
			if (!columnExists(sqlite, 'movies', 'adult_confidence')) {
				sqlite.prepare(`ALTER TABLE "movies" ADD COLUMN "adult_confidence" text`).run();
				logger.info('[Migration v096] Added adult_confidence column to movies');
			}
		}

		if (tableExists(sqlite, 'series')) {
			if (!columnExists(sqlite, 'series', 'adult')) {
				sqlite.prepare(`ALTER TABLE "series" ADD COLUMN "adult" integer NOT NULL DEFAULT 0`).run();
				logger.info('[Migration v096] Added adult column to series');
			}
			if (!columnExists(sqlite, 'series', 'adult_source')) {
				sqlite.prepare(`ALTER TABLE "series" ADD COLUMN "adult_source" text`).run();
				logger.info('[Migration v096] Added adult_source column to series');
			}
			if (!columnExists(sqlite, 'series', 'adult_confidence')) {
				sqlite.prepare(`ALTER TABLE "series" ADD COLUMN "adult_confidence" text`).run();
				logger.info('[Migration v096] Added adult_confidence column to series');
			}
		}
	}
};

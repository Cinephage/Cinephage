import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v113: MigrationDefinition = {
	version: 113,
	name: 'add_resolution_categories',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'resolution_categories')) {
			sqlite
				.prepare(
					`CREATE TABLE IF NOT EXISTS "resolution_categories" (
						"id" text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
						"label" text NOT NULL,
						"min_width" integer NOT NULL DEFAULT 0,
						"min_height" integer NOT NULL DEFAULT 0,
						"search_terms" text,
						"is_fallback" integer DEFAULT 0,
						"created_at" text NOT NULL DEFAULT (datetime('now'))
					)`
				)
				.run();

			// Seed default resolution categories (~5% lower minimums so
			// cropped/cinema-scope encodes land in the right bucket).
			const defaults = [
				{
					id: 'res-4k',
					label: '4K',
					minWidth: 3648,
					minHeight: 1520,
					searchTerms: JSON.stringify(['2160p', '4k', 'uhd', 'ultra hd']),
					isFallback: 0
				},
				{
					id: 'res-1080p',
					label: '1080p',
					minWidth: 1824,
					minHeight: 1024,
					searchTerms: JSON.stringify(['1080p', 'full hd', 'fhd']),
					isFallback: 0
				},
				{
					id: 'res-720p',
					label: '720p',
					minWidth: 1216,
					minHeight: 684,
					searchTerms: JSON.stringify(['720p', 'hd']),
					isFallback: 0
				},
				{
					id: 'res-sd',
					label: 'SD',
					minWidth: 0,
					minHeight: 0,
					searchTerms: JSON.stringify(['sd', '480p', '576p']),
					isFallback: 1
				}
			];

			const insert = sqlite.prepare(
				`INSERT INTO "resolution_categories"
				 ("id", "label", "min_width", "min_height", "search_terms", "is_fallback", "created_at")
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			);

			for (const d of defaults) {
				insert.run(
					d.id,
					d.label,
					d.minWidth,
					d.minHeight,
					d.searchTerms,
					d.isFallback,
					new Date().toISOString()
				);
			}

			logger.info('[migration v113] Created resolution_categories table with defaults');
		}
	}
};

import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 10: Flag series with broken episode metadata for automatic repair

export const migration_v010: MigrationDefinition = {
	version: 10,
	name: 'flag_broken_series_metadata',
	apply: (sqlite) => {
		logger.info('[SchemaSync] Checking for series with broken episode metadata...');

		// Find series that have episode_files but no episodes in the database
		// These series were created through the unmatched endpoint bug
		const brokenSeries = sqlite
			.prepare(
				`
			SELECT DISTINCT s.id, s.tmdb_id, s.title
			FROM series s
			INNER JOIN episode_files ef ON ef.series_id = s.id
			WHERE s.episode_count = 0 OR NOT EXISTS (
				SELECT 1 FROM episodes e WHERE e.series_id = s.id
			)
		`
			)
			.all() as Array<{ id: string; tmdb_id: number; title: string }>;

		if (brokenSeries.length === 0) {
			logger.info('[SchemaSync] No series need episode metadata repair');
			return;
		}

		logger.info(
			{
				count: brokenSeries.length,
				series: brokenSeries.map((s) => s.title)
			},
			'[SchemaSync] Found series needing episode metadata repair'
		);

		// Flag each series for repair by the DataRepairService on startup
		// We use settings table since TMDB API calls need to be async
		for (const series of brokenSeries) {
			sqlite
				.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
				.run(
					`repair_series_${series.id}`,
					JSON.stringify({ tmdbId: series.tmdb_id, title: series.title })
				);
		}

		logger.info(
			{
				count: brokenSeries.length
			},
			'[SchemaSync] Queued series for metadata repair on next startup'
		);
	}
};

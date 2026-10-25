import { randomUUID } from 'node:crypto';
import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'migration-v163' });

/**
 * Repair episodes whose season_id is null or points at a season row that no
 * longer exists.
 *
 * EpisodeMonitoredSpecification (fixed alongside this migration) used to
 * treat a broken season link as "default to monitored", silently bypassing
 * whatever the user set on the season — those episodes kept getting
 * re-searched and re-grabbed no matter how many times they were unmonitored.
 * The specification now fails closed instead, but that leaves existing
 * orphaned links stuck rejecting forever (SEASON_LINK_MISSING) unless they're
 * re-pointed at the right season here.
 *
 * For each (series_id, season_number) an orphaned episode belongs to: reuse
 * the existing season row if one exists, otherwise create one. A newly
 * created season defaults to monitored = 0 (not 1), since we have no record of
 * what the user intended for it, and after this exact bug, resurrecting
 * unwanted downloads is the worse failure mode. The user can re-monitor it
 * from the UI if that's wrong.
 */
export const migration_v163: MigrationDefinition = {
	version: 163,
	name: 'repair_orphaned_episode_seasons',
	apply: (sqlite) => {
		const orphanGroups = sqlite
			.prepare(
				`SELECT series_id, season_number, COUNT(*) as episode_count,
				        SUM(CASE WHEN has_file = 1 THEN 1 ELSE 0 END) as file_count
				 FROM episodes
				 WHERE season_id IS NULL
				    OR season_id NOT IN (SELECT id FROM seasons)
				 GROUP BY series_id, season_number`
			)
			.all() as {
			series_id: string;
			season_number: number;
			episode_count: number;
			file_count: number;
		}[];

		if (orphanGroups.length === 0) {
			logger.info('No orphaned episode-season links found');
			return;
		}

		const findSeason = sqlite.prepare(
			`SELECT id FROM seasons WHERE series_id = ? AND season_number = ?`
		);
		const insertSeason = sqlite.prepare(
			`INSERT INTO seasons (id, series_id, season_number, monitored, name, episode_count, episode_file_count)
			 VALUES (?, ?, ?, 0, ?, ?, ?)`
		);
		const relinkEpisodes = sqlite.prepare(
			`UPDATE episodes
			 SET season_id = ?
			 WHERE series_id = ? AND season_number = ?
			   AND (season_id IS NULL OR season_id NOT IN (SELECT id FROM seasons))`
		);

		let relinkedToExisting = 0;
		let seasonsCreated = 0;
		let relinkedToNew = 0;

		for (const group of orphanGroups) {
			const existing = findSeason.get(group.series_id, group.season_number) as
				{ id: string } | undefined;

			let seasonId: string;
			if (existing) {
				seasonId = existing.id;
				relinkedToExisting += group.episode_count;
			} else {
				seasonId = randomUUID();
				const name = group.season_number === 0 ? 'Specials' : `Season ${group.season_number}`;
				insertSeason.run(
					seasonId,
					group.series_id,
					group.season_number,
					name,
					group.episode_count,
					group.file_count
				);
				seasonsCreated += 1;
				relinkedToNew += group.episode_count;
			}

			relinkEpisodes.run(seasonId, group.series_id, group.season_number);
		}

		logger.info(
			{
				groups: orphanGroups.length,
				episodesRelinkedToExistingSeason: relinkedToExisting,
				seasonsCreated,
				episodesRelinkedToNewSeason: relinkedToNew
			},
			'Repaired orphaned episode-season links'
		);
	}
};

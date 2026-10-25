import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Migration 48: Dedupe episode_files rows and enforce unique path per series

export const migration_v048: MigrationDefinition = {
	version: 48,
	name: 'dedupe_episode_files_and_add_unique_path_index',
	apply: (sqlite) => {
		type DuplicateGroupRow = {
			seriesId: string;
			relativePath: string;
		};
		type EpisodeFileRow = {
			id: string;
			episodeIds: string | null;
		};
		type JsonIdRow = {
			id: string;
			value: string | null;
		};

		const duplicateGroups = sqlite
			.prepare(
				`
					SELECT
						series_id AS seriesId,
						relative_path AS relativePath
					FROM episode_files
					GROUP BY series_id, relative_path
					HAVING COUNT(*) > 1
				`
			)
			.all() as DuplicateGroupRow[];

		if (duplicateGroups.length === 0) {
			sqlite
				.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS "idx_episode_files_unique_path" ON "episode_files" ("series_id", "relative_path")`
				)
				.run();
			logger.info('[SchemaSync] episode_files already deduped, ensured unique path index');
			return;
		}

		const selectGroupRows = sqlite.prepare(
			`
				SELECT
					id,
					episode_ids AS episodeIds
				FROM episode_files
				WHERE series_id = ? AND relative_path = ?
				ORDER BY date_added ASC, id ASC
			`
		);
		const updateEpisodeIds = sqlite.prepare(
			`UPDATE episode_files SET episode_ids = ? WHERE id = ?`
		);
		const updateDownloadHistoryIds = sqlite.prepare(
			`UPDATE download_history SET episode_file_ids = ? WHERE id = ?`
		);
		const updateActivityDetailsIds = sqlite.prepare(
			`UPDATE activity_details SET replaced_episode_file_ids = ? WHERE id = ?`
		);
		const deleteEpisodeFile = sqlite.prepare(`DELETE FROM episode_files WHERE id = ?`);

		const idRemap = new Map<string, string>();
		let duplicateRowsDeleted = 0;
		let canonicalRowsUpdated = 0;

		for (const group of duplicateGroups) {
			const rows = selectGroupRows.all(group.seriesId, group.relativePath) as EpisodeFileRow[];
			if (rows.length < 2) continue;

			const canonical = rows[0];
			const canonicalEpisodeIds: string[] = [];
			const seenCanonical = new Set<string>();

			for (const row of rows) {
				let parsedIds: unknown;
				try {
					parsedIds = row.episodeIds ? JSON.parse(row.episodeIds) : [];
				} catch {
					parsedIds = [];
				}

				if (Array.isArray(parsedIds)) {
					for (const value of parsedIds) {
						if (typeof value !== 'string') continue;
						if (seenCanonical.has(value)) continue;
						seenCanonical.add(value);
						canonicalEpisodeIds.push(value);
					}
				}
			}

			let canonicalChanged = false;
			try {
				const existingParsed = canonical.episodeIds ? JSON.parse(canonical.episodeIds) : [];
				if (!Array.isArray(existingParsed)) {
					canonicalChanged = true;
				} else if (existingParsed.length !== canonicalEpisodeIds.length) {
					canonicalChanged = true;
				} else {
					for (let i = 0; i < existingParsed.length; i++) {
						if (existingParsed[i] !== canonicalEpisodeIds[i]) {
							canonicalChanged = true;
							break;
						}
					}
				}
			} catch {
				canonicalChanged = true;
			}

			if (canonicalChanged) {
				updateEpisodeIds.run(JSON.stringify(canonicalEpisodeIds), canonical.id);
				canonicalRowsUpdated++;
			}

			for (const duplicate of rows.slice(1)) {
				idRemap.set(duplicate.id, canonical.id);
				deleteEpisodeFile.run(duplicate.id);
				duplicateRowsDeleted++;
			}
		}

		let downloadHistoryRowsUpdated = 0;
		let activityDetailsRowsUpdated = 0;

		const remapIdArrayJson = (value: string | null): { changed: boolean; json: string | null } => {
			if (!value) return { changed: false, json: value };

			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				return { changed: false, json: value };
			}

			if (!Array.isArray(parsed)) return { changed: false, json: value };

			const remapped: string[] = [];
			const seen = new Set<string>();
			let changed = false;

			for (const item of parsed) {
				if (typeof item !== 'string') continue;
				const mapped = idRemap.get(item) ?? item;
				if (mapped !== item) changed = true;
				if (seen.has(mapped)) {
					changed = true;
					continue;
				}
				seen.add(mapped);
				remapped.push(mapped);
			}

			if (!changed && remapped.length === parsed.length) {
				for (let i = 0; i < parsed.length; i++) {
					if (parsed[i] !== remapped[i]) {
						changed = true;
						break;
					}
				}
			}

			if (!changed) return { changed: false, json: value };
			return { changed: true, json: JSON.stringify(remapped) };
		};

		if (idRemap.size > 0) {
			const historyRows = sqlite
				.prepare(
					`SELECT id, episode_file_ids AS value FROM download_history WHERE episode_file_ids IS NOT NULL`
				)
				.all() as JsonIdRow[];
			for (const row of historyRows) {
				const remapped = remapIdArrayJson(row.value);
				if (!remapped.changed || remapped.json === null) continue;
				updateDownloadHistoryIds.run(remapped.json, row.id);
				downloadHistoryRowsUpdated++;
			}

			const activityRows = sqlite
				.prepare(
					`SELECT id, replaced_episode_file_ids AS value FROM activity_details WHERE replaced_episode_file_ids IS NOT NULL`
				)
				.all() as JsonIdRow[];
			for (const row of activityRows) {
				const remapped = remapIdArrayJson(row.value);
				if (!remapped.changed || remapped.json === null) continue;
				updateActivityDetailsIds.run(remapped.json, row.id);
				activityDetailsRowsUpdated++;
			}
		}

		sqlite
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS "idx_episode_files_unique_path" ON "episode_files" ("series_id", "relative_path")`
			)
			.run();

		logger.info(
			{
				groupsDeduped: duplicateGroups.length,
				duplicateRowsDeleted,
				canonicalRowsUpdated,
				downloadHistoryRowsUpdated,
				activityDetailsRowsUpdated
			},
			'[SchemaSync] Deduped episode_files and enforced unique path index'
		);
	}
};

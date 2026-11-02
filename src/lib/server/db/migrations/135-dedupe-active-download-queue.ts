import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

const STATUS_PRIORITY: Record<string, number> = {
	imported: 0,
	'seeding-imported': 1,
	importing: 2,
	completed: 3,
	seeding: 4,
	downloading: 5,
	queued: 6,
	awaiting: 7,
	stalled: 8,
	paused: 9
};

type QueueRow = {
	id: string;
	download_client_id: string;
	info_hash: string;
	status: string;
	added_at: string | null;
};

export const migration_v135: MigrationDefinition = {
	version: 135,
	name: 'dedupe_active_download_queue',
	apply: (sqlite: Database.Database) => {
		const rows = sqlite
			.prepare(
				`SELECT id, download_client_id, info_hash, status, added_at
				 FROM download_queue
				 WHERE info_hash IS NOT NULL
				   AND trim(info_hash) <> ''
				   AND status NOT IN ('removed', 'failed')`
			)
			.all() as QueueRow[];

		const groups = new Map<string, QueueRow[]>();
		for (const row of rows) {
			const infoHash = row.info_hash.trim().toLowerCase();
			const key = `${row.download_client_id}\u0000${infoHash}`;
			const group = groups.get(key) ?? [];
			group.push({ ...row, info_hash: infoHash });
			groups.set(key, group);
		}

		const duplicateGroups = [...groups.values()].filter((group) => group.length > 1);
		if (duplicateGroups.length === 0) return;

		const deleteRow = sqlite.prepare('DELETE FROM download_queue WHERE id = ?');
		const updateHash = sqlite.prepare('UPDATE download_queue SET info_hash = ? WHERE id = ?');
		let deleted = 0;

		sqlite.transaction(() => {
			for (const group of duplicateGroups) {
				group.sort((a, b) => {
					const statusOrder =
						(STATUS_PRIORITY[a.status] ?? Number.MAX_SAFE_INTEGER) -
						(STATUS_PRIORITY[b.status] ?? Number.MAX_SAFE_INTEGER);
					if (statusOrder !== 0) return statusOrder;

					const addedOrder = (a.added_at ?? '').localeCompare(b.added_at ?? '');
					return addedOrder !== 0 ? addedOrder : a.id.localeCompare(b.id);
				});

				const [keep, ...duplicates] = group;
				updateHash.run(keep.info_hash, keep.id);
				for (const duplicate of duplicates) {
					deleteRow.run(duplicate.id);
					deleted++;
				}
			}
		})();

		logger.info(
			{ duplicateGroups: duplicateGroups.length, deleted },
			'[migration v135] Deduplicated active download queue rows'
		);
	}
};

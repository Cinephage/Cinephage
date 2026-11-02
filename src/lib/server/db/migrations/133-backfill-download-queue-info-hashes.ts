import type Database from 'better-sqlite3';
import { resolveInfoHash } from '#lib/server/downloadClients/utils/hashUtils.js';
import { columnExists } from '../migration-helpers.js';
import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v133: MigrationDefinition = {
	version: 133,
	name: 'backfill_download_queue_info_hashes',
	apply: (sqlite: Database.Database) => {
		if (!columnExists(sqlite, 'download_queue', 'import_failed')) {
			sqlite
				.prepare(
					`ALTER TABLE "download_queue" ADD COLUMN "import_failed" integer NOT NULL DEFAULT 0`
				)
				.run();
		}

		const rows = sqlite
			.prepare(
				`SELECT id, download_id, protocol, info_hash, magnet_url, download_url
				 FROM download_queue
				 WHERE download_id IS NOT NULL OR info_hash IS NOT NULL OR magnet_url IS NOT NULL OR download_url IS NOT NULL`
			)
			.all() as Array<{
			id: string;
			download_id: string | null;
			protocol: string | null;
			info_hash: string | null;
			magnet_url: string | null;
			download_url: string | null;
		}>;

		const update = sqlite.prepare('UPDATE download_queue SET info_hash = ? WHERE id = ?');
		let updated = 0;

		sqlite.transaction(() => {
			for (const row of rows) {
				const infoHash = resolveInfoHash(
					row.info_hash,
					row.magnet_url,
					row.download_url,
					row.protocol === 'torrent' ? row.download_id : undefined
				);
				if (infoHash && infoHash !== row.info_hash) {
					update.run(infoHash, row.id);
					updated++;
				}
			}
		})();

		logger.info({ updated }, '[migration v133] Backfilled download queue info hashes');
	}
};

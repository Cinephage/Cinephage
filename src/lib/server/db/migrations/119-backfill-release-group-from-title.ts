import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';

const logger = createChildLogger({ logDomain: 'system' as const });

// Migration 119: Backfill release_group for download_queue and download_history
// rows that were written before the parser normalized separators. The activity
// feed no longer re-parses titles at display time (which was separator-sensitive
// and failed on dotted, dash-less titles like "...x264.RARBG"), so legacy rows
// need their release_group populated from the stored title one time here.

interface TitleRow {
	id: string;
	title: string | null;
}

function backfillTable(
	sqlite: Parameters<MigrationDefinition['apply']>[0],
	parser: ReleaseParser,
	table: 'download_queue' | 'download_history'
): number {
	// Guard: legacy DBs migrating from the old schema_version system to the
	// migration-tracking table may reach this migration before the table or the
	// release_group column exists (migration 039 gets marked applied without
	// running). Skip gracefully rather than throwing on a missing column.
	if (!tableExists(sqlite, table) || !columnExists(sqlite, table, 'release_group')) {
		return 0;
	}

	const rows = sqlite
		.prepare(
			`SELECT id, title FROM ${table} WHERE release_group IS NULL AND title IS NOT NULL AND title <> ''`
		)
		.all() as TitleRow[];

	const update = sqlite.prepare(`UPDATE ${table} SET release_group = ? WHERE id = ?`);

	let updated = 0;
	const applyBackfill = sqlite.transaction((items: TitleRow[]) => {
		for (const row of items) {
			if (!row.title) continue;
			const group = parser.parse(row.title).releaseGroup;
			if (group) {
				update.run(group, row.id);
				updated++;
			}
		}
	});
	applyBackfill(rows);

	return updated;
}

export const migration_v119: MigrationDefinition = {
	version: 119,
	name: 'backfill_release_group_from_title',
	apply: (sqlite) => {
		const parser = new ReleaseParser();

		const queueUpdated = backfillTable(sqlite, parser, 'download_queue');
		const historyUpdated = backfillTable(sqlite, parser, 'download_history');

		logger.info(
			{ queueUpdated, historyUpdated },
			'[SchemaSync] Backfilled release_group from title for queue and history rows'
		);
	}
};

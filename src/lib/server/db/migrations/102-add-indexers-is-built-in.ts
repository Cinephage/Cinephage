import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';

// Hardcoded (not imported from #lib/server/indexers/types) so migrations stay
// decoupled from app code. This ID matches data/indexers/definitions/cinephage-stream.yaml
// and is stable for the lifetime of this migration.
const CINEPHAGE_STREAM_DEFINITION_ID = 'cinephage-stream';

/**
 * Migration 102: Add indexers.is_built_in column.
 *
 * Adds a boolean column to mark system-owned indexer rows. The only row that
 * gets backfilled to is_built_in = 1 today is the cinephage-stream row owned
 * by the CinephageAPI subsystem's library-streaming module.
 *
 * CRUD guards in IndexerManager and /api/indexers/[id]/+server.ts reject
 * delete and field-restricted update operations on these rows. The owning
 * subsystem manages their lifecycle.
 *
 * Column convention matches scoringProfiles.is_built_in (schema.ts:401) and
 * namingPresets.is_built_in (schema.ts:1195).
 */
export const migration_v102: MigrationDefinition = {
	version: 102,
	name: 'add_indexers_is_built_in',
	apply: (sqlite) => {
		if (!columnExists(sqlite, 'indexers', 'is_built_in')) {
			sqlite
				.prepare(`ALTER TABLE "indexers" ADD COLUMN "is_built_in" integer NOT NULL DEFAULT 0`)
				.run();
		}

		// Backfill: mark the cinephage-stream row as built-in. The seeding logic
		// that creates this row historically lived in IndexerManager.seedStreamingIndexer();
		// after this migration it lives in the LibraryStreamingModule. Either way
		// any pre-existing row with this definitionId is system-owned.
		const result = sqlite
			.prepare(
				`UPDATE "indexers" SET "is_built_in" = 1 WHERE "definition_id" = ? AND "is_built_in" = 0`
			)
			.run(CINEPHAGE_STREAM_DEFINITION_ID);

		// Best-effort: no per-migration logger to keep this file decoupled from
		// app code (see CinephageApiService.test.ts history). The schema-sync
		// framework already logs migration application externally.
		void result;
	}
};

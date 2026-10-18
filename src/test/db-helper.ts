import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '#lib/server/db/schema.js';
import { syncSchema } from '#lib/server/db/schema-sync.js';

export interface TestDatabase {
	sqlite: ReturnType<typeof Database>;
	db: ReturnType<typeof drizzle>;
}

export function createTestDb(): TestDatabase {
	const sqlite = new Database(':memory:');
	const db = drizzle(sqlite, { schema });
	syncSchema(sqlite);
	return { sqlite, db };
}

export function destroyTestDb(testDb: TestDatabase) {
	testDb.sqlite.close();
}

// Storage / media-server tables. Cleared BEFORE core tables because storage_items
// references movie_files / episode_files. Children-first ordering.
const STORAGE_TABLES = [
	'storageItemServerLinks',
	'storageInsights',
	'storageItems',
	'mediaServerSyncedItems',
	'mediaServerSyncedRuns',
	'mediaBrowserServers'
] as const;

const CORE_TABLES = [
	'scoringProfiles',
	'customFormats',
	'blockedMedia',
	'blocklist',
	'downloadClients',
	'movies',
	'movieFiles',
	'series',
	'seasons',
	'episodes',
	'episodeFiles',
	'downloadQueue',
	'rootFolders',
	'unmatchedFiles'
] as const;

export function clearTestDb(testDb: TestDatabase) {
	for (const table of STORAGE_TABLES) {
		testDb.db.delete(schema[table]).run();
	}
	for (const table of CORE_TABLES) {
		testDb.db.delete(schema[table]).run();
	}
}

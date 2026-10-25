import type Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 142: Allow AniList/MAL title variants in alternate_titles.
//
// The original v038 DDL shipped `source text NOT NULL CHECK (source IN
// ('tmdb','user'))`, which would reject the new anime provider variants.
// SQLite cannot alter a CHECK constraint in place, so the table is rebuilt
// (copy → drop → rename → reindex) only when the old CHECK is still present.

/** Marker of the pre-v142 source CHECK in the table DDL. */
const LEGACY_SOURCE_CHECK_MARKER = "('tmdb','user')";

const ALTERNATE_TITLES_COLUMNS = `
	"id" integer PRIMARY KEY AUTOINCREMENT,
	"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'series')),
	"media_id" text NOT NULL,
	"title" text NOT NULL,
	"clean_title" text NOT NULL,
	"source" text NOT NULL CHECK ("source" IN ('tmdb', 'user', 'anilist', 'mal')),
	"language" text,
	"country" text,
	"created_at" text
`;

const ALTERNATE_TITLES_INDEXES = [
	`CREATE INDEX "idx_alternate_titles_media" ON "alternate_titles" ("media_type", "media_id")`,
	`CREATE INDEX "idx_alternate_titles_source" ON "alternate_titles" ("source")`
];

function getTableSql(sqlite: Database.Database, tableName: string): string {
	const row = sqlite
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
		.get(tableName) as { sql: string | null } | undefined;
	return (row?.sql ?? '').replace(/\s+/g, '').toLowerCase();
}

export const migration_v142: MigrationDefinition = {
	version: 142,
	name: 'allow_anilist_mal_alternate_title_sources',
	apply: (sqlite: Database.Database) => {
		if (!tableExists(sqlite, 'alternate_titles')) return;
		if (!getTableSql(sqlite, 'alternate_titles').includes(LEGACY_SOURCE_CHECK_MARKER)) return;

		const tempName = 'alternate_titles__v142_new';
		const indexRows = sqlite
			.prepare(
				`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`
			)
			.all('alternate_titles') as Array<{ name: string; sql: string }>;

		sqlite.exec(`DROP TABLE IF EXISTS "${tempName}"`);
		sqlite.exec(`CREATE TABLE "${tempName}" (\n${ALTERNATE_TITLES_COLUMNS}\n)`);

		// Column sets are identical between v038 and v142 — copy everything.
		sqlite.exec(
			`INSERT INTO "${tempName}" (id, media_type, media_id, title, clean_title, source, language, country, created_at)
			 SELECT id, media_type, media_id, title, clean_title, source, language, country, created_at FROM "alternate_titles"`
		);
		sqlite.exec(`DROP TABLE "alternate_titles"`);
		sqlite.exec(`ALTER TABLE "${tempName}" RENAME TO "alternate_titles"`);

		for (const index of indexRows) {
			// The named indexes died with the old table, so the names are free again.
			sqlite.exec(index.sql);
		}

		logger.info(
			{ rows: sqlite.prepare(`SELECT COUNT(*) FROM alternate_titles`).pluck().get() as number },
			'[migration v142] Rebuilt alternate_titles with anilist/mal sources allowed'
		);

		// Defensive: recreate the standard indexes when the old table carried none
		// under their expected names (fresh rebuild above always recreates them,
		// but this keeps databases drifted by older partial upgrades consistent).
		for (const indexSql of ALTERNATE_TITLES_INDEXES) {
			sqlite.exec(`${indexSql.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS')}`);
		}
	}
};

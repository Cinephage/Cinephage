import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migration_v201 } from './201-music-smart-list-items.js';

const OLD_DDL = `
CREATE TABLE "smart_list_items" (
	"id" text PRIMARY KEY NOT NULL,
	"smart_list_id" text NOT NULL,
	"media_type" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"in_library" integer DEFAULT false,
	UNIQUE("smart_list_id", "tmdb_id")
)`;

let sqlite: Database.Database;

beforeEach(() => {
	sqlite = new Database(':memory:');
});

afterEach(() => {
	sqlite.close();
});

function columns() {
	return sqlite.prepare('PRAGMA table_info("smart_list_items")').all() as Array<{
		name: string;
		notnull: number;
	}>;
}

describe('migration 201 - music smart list items', () => {
	it('makes tmdb_id nullable, adds the music columns and keeps every row', () => {
		// The live table has this target; the rebuild's album_id FK needs it.
		sqlite.prepare(`CREATE TABLE "albums" ("id" text PRIMARY KEY NOT NULL)`).run();
		sqlite.prepare(OLD_DDL).run();
		sqlite
			.prepare(
				`CREATE INDEX "idx_smart_list_items_tmdb" ON "smart_list_items" ("tmdb_id", "media_type")`
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO "smart_list_items" ("id", "smart_list_id", "media_type", "tmdb_id", "title", "position", "in_library")
				 VALUES ('item-1', 'list-1', 'movie', 603, 'The Matrix', 0, 1)`
			)
			.run();

		migration_v201.apply(sqlite);

		const cols = columns();
		expect(cols.find((column) => column.name === 'tmdb_id')?.notnull).toBe(0);
		for (const name of [
			'mbid',
			'artist_name',
			'artist_mbid',
			'album_id',
			'cover_url',
			'track_count',
			'primary_type'
		]) {
			expect(cols.some((column) => column.name === name)).toBe(true);
		}

		const row = sqlite
			.prepare(`SELECT * FROM "smart_list_items" WHERE "id" = 'item-1'`)
			.get() as Record<string, unknown>;
		expect(row.title).toBe('The Matrix');
		expect(row.tmdb_id).toBe(603);
		expect(row.in_library).toBe(1);
		expect(row.mbid).toBeNull();

		const indexes = sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'smart_list_items'`
			)
			.all() as Array<{ name: string }>;
		const names = indexes.map((index) => index.name);
		expect(names).toContain('idx_smart_list_items_tmdb');
		expect(names).toContain('idx_smart_list_items_mbid');
		expect(names).toContain('idx_smart_list_items_album');
		expect(names).toContain('idx_smart_list_items_list_mbid');

		// The per-list release-group guard is real, not just an index name.
		sqlite
			.prepare(
				`INSERT INTO "smart_list_items" ("id", "smart_list_id", "media_type", "title", "position", "mbid")
				 VALUES ('item-a', 'list-3', 'music', 'Discovery', 0, 'rg-discovery')`
			)
			.run();
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO "smart_list_items" ("id", "smart_list_id", "media_type", "title", "position", "mbid")
					 VALUES ('item-b', 'list-3', 'music', 'Discovery', 1, 'rg-discovery')`
				)
				.run()
		).toThrow(/UNIQUE/);
	});

	it('is a no-op on a table that already has the music shape', () => {
		sqlite
			.prepare(
				`CREATE TABLE "smart_list_items" (
					"id" text PRIMARY KEY NOT NULL,
					"smart_list_id" text NOT NULL,
					"media_type" text NOT NULL,
					"tmdb_id" integer,
					"title" text NOT NULL,
					"position" integer NOT NULL,
					"in_library" integer DEFAULT false,
					"mbid" text,
					"artist_name" text,
					"artist_mbid" text,
					"album_id" text,
					"cover_url" text,
					"track_count" integer,
					"primary_type" text,
					UNIQUE("smart_list_id", "tmdb_id")
				)`
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO "smart_list_items" ("id", "smart_list_id", "media_type", "title", "position", "mbid")
				 VALUES ('item-2', 'list-2', 'music', 'Discovery', 0, 'rg-discovery')`
			)
			.run();

		migration_v201.apply(sqlite);
		migration_v201.apply(sqlite);

		const rows = sqlite.prepare(`SELECT * FROM "smart_list_items"`).all();
		expect(rows).toHaveLength(1);
		expect((rows[0] as Record<string, unknown>).mbid).toBe('rg-discovery');
	});
});

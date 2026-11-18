import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration_v181 } from './181-widen-media-type-check.js';

/**
 * The migration rebuilds tables from their live DDL, so the cases that matter
 * are the ones a hand-written rebuild gets wrong: columns appended by an
 * earlier migration, indexes created before the rebuild, and a second run.
 */
function schemaOf(sqlite: Database.Database, table: string): string {
	return (
		sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table) as {
			sql: string;
		}
	).sql;
}

function indexNames(sqlite: Database.Database, table: string): string[] {
	return (
		sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? ORDER BY name`)
			.all(table) as { name: string }[]
	).map((row) => row.name);
}

describe('migration v181 — widen media_type CHECKs for music', () => {
	it('preserves rows, columns and indexes while adding music to the CHECK', () => {
		const sqlite = new Database(':memory:');
		// The initial shape, plus a column a later migration would have ALTERed in.
		sqlite
			.prepare(
				`CREATE TABLE "libraries" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'tv')),
					"scan_mode" text DEFAULT 'scheduled' NOT NULL
				)`
			)
			.run();
		sqlite.prepare(`CREATE INDEX "idx_libraries_media_type" ON "libraries" ("media_type")`).run();
		sqlite
			.prepare(
				`INSERT INTO "libraries" ("id", "name", "media_type", "scan_mode") VALUES (?, ?, ?, ?)`
			)
			.run('lib-1', 'Movies', 'movie', 'scheduled');
		sqlite
			.prepare(
				`INSERT INTO "libraries" ("id", "name", "media_type", "scan_mode") VALUES (?, ?, ?, ?)`
			)
			.run('lib-2', 'TV', 'tv', 'manual');

		migration_v181.apply(sqlite);

		expect(schemaOf(sqlite, 'libraries')).toContain(
			`CHECK ("media_type" IN ('movie', 'tv', 'music'))`
		);
		expect(schemaOf(sqlite, 'libraries')).toContain('"scan_mode"');
		expect(sqlite.prepare(`SELECT count(*) AS n FROM "libraries"`).get()).toEqual({ n: 2 });
		expect(sqlite.prepare(`SELECT scan_mode FROM "libraries" WHERE id = 'lib-1'`).get()).toEqual({
			scan_mode: 'scheduled'
		});
		expect(indexNames(sqlite, 'libraries')).toContain('idx_libraries_media_type');

		// The point of the rebuild: music is now a legal value, garbage still is not.
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO "libraries" ("id", "name", "media_type") VALUES ('lib-3', 'Music', 'music')`
				)
				.run()
		).not.toThrow();
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO "libraries" ("id", "name", "media_type") VALUES ('lib-4', 'Books', 'book')`
				)
				.run()
		).toThrow(/CHECK constraint failed/);
		sqlite.close();
	});

	it('keeps alternate_titles own vocabulary instead of assuming movie/tv', () => {
		const sqlite = new Database(':memory:');
		sqlite
			.prepare(
				`CREATE TABLE "alternate_titles" (
					"id" integer PRIMARY KEY AUTOINCREMENT,
					"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'series')),
					"media_id" text NOT NULL,
					"title" text NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO "alternate_titles" ("media_type", "media_id", "title") VALUES ('series', 's-1', 'Alias')`
			)
			.run();

		migration_v181.apply(sqlite);

		expect(schemaOf(sqlite, 'alternate_titles')).toContain(
			`CHECK ("media_type" IN ('movie', 'series', 'music'))`
		);
		expect(sqlite.prepare(`SELECT count(*) AS n FROM "alternate_titles"`).get()).toEqual({ n: 1 });
		sqlite.close();
	});

	it('is idempotent — a second run changes nothing', () => {
		const sqlite = new Database(':memory:');
		sqlite
			.prepare(
				`CREATE TABLE "libraries" (
					"id" text PRIMARY KEY NOT NULL,
					"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'tv'))
				)`
			)
			.run();
		sqlite.prepare(`INSERT INTO "libraries" ("id", "media_type") VALUES ('lib-1', 'movie')`).run();

		migration_v181.apply(sqlite);
		const afterFirst = schemaOf(sqlite, 'libraries');
		migration_v181.apply(sqlite);

		expect(schemaOf(sqlite, 'libraries')).toBe(afterFirst);
		expect(afterFirst).toContain(`('movie', 'tv', 'music')`);
		expect(sqlite.prepare(`SELECT count(*) AS n FROM "libraries"`).get()).toEqual({ n: 1 });
		sqlite.close();
	});

	it('leaves a table without a media_type CHECK alone', () => {
		const sqlite = new Database(':memory:');
		sqlite
			.prepare(
				`CREATE TABLE "metadata_conflicts" ("id" text PRIMARY KEY NOT NULL, "media_type" text NOT NULL)`
			)
			.run();
		const before = schemaOf(sqlite, 'metadata_conflicts');

		migration_v181.apply(sqlite);

		expect(schemaOf(sqlite, 'metadata_conflicts')).toBe(before);
		sqlite.close();
	});
});

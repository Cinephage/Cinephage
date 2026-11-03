import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v142 } from './142-allow-anilist-mal-alternate-title-sources.js';

const databases: Database.Database[] = [];

/** Exact v038 DDL (the shape every existing production database carries). */
const PRE_MIGRATION_DDL = `
	CREATE TABLE "alternate_titles" (
		"id" integer PRIMARY KEY AUTOINCREMENT,
		"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'series')),
		"media_id" text NOT NULL,
		"title" text NOT NULL,
		"clean_title" text NOT NULL,
		"source" text NOT NULL CHECK ("source" IN ('tmdb', 'user')),
		"language" text,
		"country" text,
		"created_at" text
	);
	CREATE INDEX "idx_alternate_titles_media" ON "alternate_titles" ("media_type", "media_id");
	CREATE INDEX "idx_alternate_titles_source" ON "alternate_titles" ("source");
`;

const SEED_SQL = `
	INSERT INTO alternate_titles (media_type, media_id, title, clean_title, source, language, country, created_at)
		VALUES ('movie', 'movie-1', 'Dűne', 'dune', 'tmdb', NULL, 'HU', '2026-01-01'),
		       ('movie', 'movie-1', 'My Title', 'my title', 'user', NULL, NULL, '2026-01-02'),
		       ('series', 'series-1', 'ダーク', 'ダーク', 'tmdb', NULL, 'DE', '2026-01-03')
`;

function createPreMigrationDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(PRE_MIGRATION_DDL);
	sqlite.exec(SEED_SQL);
	return sqlite;
}

function tableDdl(sqlite: Database.Database, tableName: string): string {
	const row = sqlite
		.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
		.get(tableName) as { sql: string } | undefined;
	return (row?.sql ?? '').replace(/\s+/g, '');
}

function indexNames(sqlite: Database.Database): string[] {
	return (
		sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{
			name: string;
		}>
	).map((r) => r.name);
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('migration v142 - allow anilist/mal alternate title sources', () => {
	it('rebuilds the table so anilist/mal sources pass the source CHECK', () => {
		const sqlite = createPreMigrationDatabase();

		// Precondition: the old CHECK rejects the new sources.
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO alternate_titles (media_type, media_id, title, clean_title, source)
					 VALUES ('movie', 'movie-2', 'X', 'x', 'anilist')`
				)
				.run()
		).toThrow(/CHECK/);

		migration_v142.apply(sqlite);

		// New sources are accepted.
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO alternate_titles (media_type, media_id, title, clean_title, source, language, country)
					 VALUES ('movie', 'movie-2', 'カウボーイビバップ', 'カウボーイビバップ', 'anilist', NULL, 'JP'),
					        ('movie', 'movie-2', 'Kaubōi Bibappu', 'kaubōi bibappu', 'mal', NULL, NULL)`
				)
				.run()
		).not.toThrow();

		// Every pre-existing row survives the rebuild unchanged.
		const rows = sqlite
			.prepare(
				`SELECT media_type, media_id, title, source, language, country FROM alternate_titles ORDER BY id`
			)
			.all();
		expect(rows.length).toBe(5);
		expect(rows[0]).toMatchObject({
			media_type: 'movie',
			title: 'Dűne',
			source: 'tmdb',
			country: 'HU'
		});
		expect(rows[1]).toMatchObject({ media_type: 'movie', title: 'My Title', source: 'user' });

		// Indexes recreated.
		expect(indexNames(sqlite)).toContain('idx_alternate_titles_media');
		expect(indexNames(sqlite)).toContain('idx_alternate_titles_source');

		// Transient rebuild table is gone.
		const tables = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(tables).not.toContain('alternate_titles__v142_new');
	});

	it('is idempotent: a second apply neither errors nor loses rows', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v142.apply(sqlite);
		const countAfterFirst = sqlite
			.prepare(`SELECT COUNT(*) FROM alternate_titles`)
			.pluck()
			.get() as number;

		expect(() => migration_v142.apply(sqlite)).not.toThrow();
		expect(sqlite.prepare(`SELECT COUNT(*) FROM alternate_titles`).pluck().get() as number).toBe(
			countAfterFirst
		);
		expect(tableDdl(sqlite, 'alternate_titles')).toContain("'anilist'");
	});

	it('skips the rebuild when the source CHECK already allows anilist (fresh DDL)', () => {
		const sqlite = new Database(':memory:');
		databases.push(sqlite);
		sqlite.exec(`
			CREATE TABLE "alternate_titles" (
				"id" integer PRIMARY KEY AUTOINCREMENT,
				"media_type" text NOT NULL CHECK ("media_type" IN ('movie', 'series')),
				"media_id" text NOT NULL,
				"title" text NOT NULL,
				"clean_title" text NOT NULL,
				"source" text NOT NULL CHECK ("source" IN ('tmdb', 'user', 'anilist', 'mal')),
				"language" text,
				"country" text,
				"created_at" text
			)
		`);
		const ddlBefore = tableDdl(sqlite, 'alternate_titles');

		expect(() => migration_v142.apply(sqlite)).not.toThrow();
		expect(tableDdl(sqlite, 'alternate_titles')).toBe(ddlBefore);
	});

	it('does nothing when alternate_titles does not exist yet', () => {
		const sqlite = new Database(':memory:');
		databases.push(sqlite);

		expect(() => migration_v142.apply(sqlite)).not.toThrow();
		const tables = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(tables).not.toContain('alternate_titles');
	});
});

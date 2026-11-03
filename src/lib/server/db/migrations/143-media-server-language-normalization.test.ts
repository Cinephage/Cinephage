import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v143 } from './143-media-server-language-normalization.js';

const databases: Database.Database[] = [];

/**
 * Minimal pre-v140 fixture mirroring the shipped media_server_synced_items
 * shape (migration 082): JSON-array language columns, no raw columns yet.
 */
const PRE_MIGRATION_DDL = `
	CREATE TABLE "media_server_synced_items" (
		"id" text PRIMARY KEY NOT NULL,
		"server_id" text NOT NULL,
		"server_item_id" text NOT NULL,
		"title" text NOT NULL,
		"item_type" text NOT NULL,
		"audio_languages" text DEFAULT '[]',
		"subtitle_languages" text DEFAULT '[]',
		"last_synced_at" text NOT NULL
	)
`;

const SEED_SQL = `
	-- (a) mixed-case + 3-letter codes needing canonicalization
	INSERT INTO media_server_synced_items (id, server_id, server_item_id, title, item_type, audio_languages, subtitle_languages, last_synced_at)
		VALUES ('item-mixed', 'srv-1', 'p-1', 'Mixed', 'movie', '["ENG","fre","ENg"]', '["Spa","dut"]', '2026-01-01');

	-- (b) already-canonical arrays: unchanged content, raws recorded as-is
	INSERT INTO media_server_synced_items (id, server_id, server_item_id, title, item_type, audio_languages, subtitle_languages, last_synced_at)
		VALUES ('item-canonical', 'srv-1', 'p-2', 'Canonical', 'movie', '["en","fr"]', '[]', '2026-01-01');

	-- (c) duplicates + empties + unknown markers collapse/drop in canonical view
	INSERT INTO media_server_synced_items (id, server_id, server_item_id, title, item_type, audio_languages, subtitle_languages, last_synced_at)
		VALUES ('item-messy', 'srv-1', 'p-3', 'Messy', 'movie', '["eng","EN","","multi","und"]', '["","jpn","jpn"]', '2026-01-01');

	-- (d) malformed JSON: untouched + logged
	INSERT INTO media_server_synced_items (id, server_id, server_item_id, title, item_type, audio_languages, subtitle_languages, last_synced_at)
		VALUES ('item-broken', 'srv-1', 'p-4', 'Broken', 'movie', '{not json', '["eng"]', '2026-01-01');

	-- (e) NULL language columns: untouched, raws stay NULL
	INSERT INTO media_server_synced_items (id, server_id, server_item_id, title, item_type, audio_languages, subtitle_languages, last_synced_at)
		VALUES ('item-null', 'srv-1', 'p-5', 'Null', 'movie', NULL, NULL, '2026-01-01');
`;

/**
 * Pre-v140 epg_programs fixture mirroring the shipped shape (migration 052):
 * plain text columns only, no i18n columns yet.
 */
const PRE_MIGRATION_EPG_DDL = `
	CREATE TABLE "epg_programs" (
		"id" text PRIMARY KEY NOT NULL,
		"channel_id" text NOT NULL,
		"external_channel_id" text NOT NULL,
		"account_id" text NOT NULL,
		"provider_type" text NOT NULL,
		"title" text NOT NULL,
		"description" text,
		"category" text,
		"director" text,
		"actor" text,
		"start_time" text NOT NULL,
		"end_time" text NOT NULL,
		"duration" integer NOT NULL,
		"has_archive" integer DEFAULT 0,
		"cached_at" text,
		"updated_at" text
	)
`;

const EPG_SEED_SQL = `
	INSERT INTO epg_programs (id, channel_id, external_channel_id, account_id, provider_type, title, description, category, start_time, end_time, duration, cached_at, updated_at)
		VALUES ('prog-1', 'chan-1', 'xml-c1', 'acct-1', 'm3u', 'News', 'Plain description', 'Sports', '2026-09-13T00:00:00Z', '2026-09-13T01:00:00Z', 3600, '2026-01-01', '2026-01-01');
`;

function createPreMigrationDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(PRE_MIGRATION_DDL);
	sqlite.exec(SEED_SQL);
	sqlite.exec(PRE_MIGRATION_EPG_DDL);
	sqlite.exec(EPG_SEED_SQL);
	return sqlite;
}

function getColumnNames(sqlite: Database.Database, tableName: string): string[] {
	return (sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map(
		(column) => column.name
	);
}

interface LanguageRow {
	id: string;
	audio_languages: string | null;
	subtitle_languages: string | null;
	audio_languages_raw: string | null;
	subtitle_languages_raw: string | null;
}

function languageRows(sqlite: Database.Database): Record<string, LanguageRow> {
	const rows = sqlite
		.prepare(
			`SELECT id, audio_languages, subtitle_languages,
					audio_languages_raw, subtitle_languages_raw
			 FROM media_server_synced_items ORDER BY id`
		)
		.all() as LanguageRow[];
	return Object.fromEntries(rows.map((row) => [row.id, row]));
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('migration v140 - media-server language normalization', () => {
	it('adds the nullable raw language columns', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v143.apply(sqlite);

		const columns = getColumnNames(sqlite, 'media_server_synced_items');
		expect(columns).toContain('audio_languages_raw');
		expect(columns).toContain('subtitle_languages_raw');
	});

	it('canonicalizes existing arrays while preserving the raw source strings', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v143.apply(sqlite);

		const rows = languageRows(sqlite);

		// (a) mixed-case / 3-letter codes canonicalize; raws keep the originals.
		expect(JSON.parse(rows['item-mixed'].audio_languages!)).toEqual(['en', 'fr']);
		expect(JSON.parse(rows['item-mixed'].audio_languages_raw!)).toEqual(['ENG', 'fre', 'ENg']);
		expect(JSON.parse(rows['item-mixed'].subtitle_languages!)).toEqual(['es', 'nl']);
		expect(JSON.parse(rows['item-mixed'].subtitle_languages_raw!)).toEqual(['Spa', 'dut']);

		// (b) already canonical: content unchanged, raws still recorded.
		expect(JSON.parse(rows['item-canonical'].audio_languages!)).toEqual(['en', 'fr']);
		expect(JSON.parse(rows['item-canonical'].audio_languages_raw!)).toEqual(['en', 'fr']);
		expect(JSON.parse(rows['item-canonical'].subtitle_languages!)).toEqual([]);
		expect(JSON.parse(rows['item-canonical'].subtitle_languages_raw!)).toEqual([]);

		// (c) duplicates collapse to first occurrence, empties and unknown
		//     (`multi`/`und`) drop from canonical; unknown non-empty raws survive
		//     in the raw view only.
		expect(JSON.parse(rows['item-messy'].audio_languages!)).toEqual(['en']);
		expect(JSON.parse(rows['item-messy'].audio_languages_raw!)).toEqual([
			'eng',
			'EN',
			'multi',
			'und'
		]);
		expect(JSON.parse(rows['item-messy'].subtitle_languages!)).toEqual(['ja']);
		expect(JSON.parse(rows['item-messy'].subtitle_languages_raw!)).toEqual(['jpn']);
	});

	it('leaves malformed-JSON rows untouched with NULL raws', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v143.apply(sqlite);

		const rows = languageRows(sqlite);
		expect(rows['item-broken'].audio_languages).toBe('{not json');
		expect(rows['item-broken'].audio_languages_raw).toBeNull();
		// The healthy sibling column on the same row is still processed.
		expect(JSON.parse(rows['item-broken'].subtitle_languages!)).toEqual(['en']);
		expect(JSON.parse(rows['item-broken'].subtitle_languages_raw!)).toEqual(['eng']);

		// (e) NULL language columns stay NULL.
		expect(rows['item-null'].audio_languages).toBeNull();
		expect(rows['item-null'].audio_languages_raw).toBeNull();
	});

	it('is idempotent: a second apply never feeds canonical arrays back into raws', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v143.apply(sqlite);
		const afterFirst = languageRows(sqlite);

		expect(() => migration_v143.apply(sqlite)).not.toThrow();
		expect(languageRows(sqlite)).toEqual(afterFirst);

		// Spot-check: the raw column still holds the pre-migration strings.
		expect(JSON.parse(languageRows(sqlite)['item-mixed'].audio_languages_raw!)).toEqual([
			'ENG',
			'fre',
			'ENg'
		]);
	});

	it('passes the integrity gates', () => {
		const sqlite = createPreMigrationDatabase();

		expect(() => migration_v143.apply(sqlite)).not.toThrow();
		expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(sqlite.prepare('PRAGMA quick_check').pluck().get()).toBe('ok');
	});

	it('does nothing when media_server_synced_items does not exist yet', () => {
		const sqlite = new Database(':memory:');
		databases.push(sqlite);

		expect(() => migration_v143.apply(sqlite)).not.toThrow();
		const tables = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(tables).not.toContain('media_server_synced_items');
	});
});

describe('migration v140 - epg_programs i18n columns (Phase 5 Task 3)', () => {
	it('adds the nullable i18n JSON columns', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v143.apply(sqlite);

		const columns = getColumnNames(sqlite, 'epg_programs');
		expect(columns).toContain('title_i18n');
		expect(columns).toContain('description_i18n');
		expect(columns).toContain('category_i18n');
	});

	it('keeps existing rows with NULL i18n columns and intact plain text', () => {
		const sqlite = createPreMigrationDatabase();

		migration_v143.apply(sqlite);

		const row = sqlite
			.prepare(
				`SELECT title, description, category, title_i18n, description_i18n, category_i18n
				 FROM epg_programs WHERE id = 'prog-1'`
			)
			.get() as {
			title: string;
			description: string | null;
			category: string | null;
			title_i18n: string | null;
			description_i18n: string | null;
			category_i18n: string | null;
		};
		expect(row.title).toBe('News');
		expect(row.description).toBe('Plain description');
		expect(row.category).toBe('Sports');
		expect(row.title_i18n).toBeNull();
		expect(row.description_i18n).toBeNull();
		expect(row.category_i18n).toBeNull();
	});

	it('is idempotent for the epg_programs columns', () => {
		const sqlite = createPreMigrationDatabase();
		migration_v143.apply(sqlite);
		const afterFirst = sqlite.prepare('SELECT * FROM epg_programs').all();

		expect(() => migration_v143.apply(sqlite)).not.toThrow();
		expect(sqlite.prepare('SELECT * FROM epg_programs').all()).toEqual(afterFirst);
		expect(getColumnNames(sqlite, 'epg_programs').filter((c) => c.endsWith('_i18n'))).toEqual([
			'title_i18n',
			'description_i18n',
			'category_i18n'
		]);
	});

	it('does nothing when epg_programs does not exist yet', () => {
		const sqlite = new Database(':memory:');
		databases.push(sqlite);
		sqlite.exec(PRE_MIGRATION_DDL);

		expect(() => migration_v143.apply(sqlite)).not.toThrow();
		const tables = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(tables).not.toContain('epg_programs');
	});
});

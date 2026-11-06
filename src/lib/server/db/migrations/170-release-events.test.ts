import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration_v170 } from './170-release-events.js';
import { MIGRATIONS } from './index.js';

function freshDb(): Database.Database {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = OFF');
	return sqlite;
}

function indexNames(sqlite: Database.Database, table: string): string[] {
	const rows = sqlite
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
		.all(table) as { name: string }[];
	return rows.map((row) => row.name).sort();
}

describe('migration 170 - release_events', () => {
	it('is registered in the migration list', () => {
		expect(MIGRATIONS.some((migration) => migration.version === 170)).toBe(true);
	});

	it('creates the table with the expected columns', () => {
		const sqlite = freshDb();
		migration_v170.apply(sqlite);

		const columns = (
			sqlite.prepare(`PRAGMA table_info('release_events')`).all() as { name: string }[]
		).map((column) => column.name);

		expect(columns).toEqual([
			'id',
			'media_type',
			'media_id',
			'kind',
			'region',
			'platform',
			'release_date',
			'release_time',
			'timezone',
			'source',
			'source_id',
			'confidence',
			'created_at',
			'updated_at'
		]);
		sqlite.close();
	});

	it('creates the natural-key unique index and lookup indexes', () => {
		const sqlite = freshDb();
		migration_v170.apply(sqlite);
		expect(indexNames(sqlite, 'release_events')).toContain('idx_release_events_natural_key');
		expect(indexNames(sqlite, 'release_events')).toContain('idx_release_events_media');
		expect(indexNames(sqlite, 'release_events')).toContain('idx_release_events_date');
		expect(indexNames(sqlite, 'release_events')).toContain('idx_release_events_kind_date');
		sqlite.close();
	});

	it('is idempotent - applying twice does not throw or duplicate', () => {
		const sqlite = freshDb();
		migration_v170.apply(sqlite);
		expect(() => migration_v170.apply(sqlite)).not.toThrow();

		const tables = (
			sqlite
				.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'release_events'`)
				.get() as { n: number }
		).n;
		expect(tables).toBe(1);
		sqlite.close();
	});

	it('rejects a duplicate natural key but allows a second date for the same kind', () => {
		const sqlite = freshDb();
		migration_v170.apply(sqlite);

		const insert = sqlite.prepare(
			`INSERT INTO release_events
				(id, media_type, media_id, kind, region, release_date, source, source_id, created_at, updated_at)
			 VALUES (?, 'movie', 'm1', 'theatrical', 'US', ?, 'tmdb', ?, '2026-01-01', '2026-01-01')`
		);

		insert.run('e1', '2026-05-01', 'tmdb:1');
		expect(() => insert.run('e2', '2026-05-01', 'tmdb:1')).toThrow();
		expect(() => insert.run('e3', '2026-05-15', 'tmdb:2')).not.toThrow();
		sqlite.close();
	});
});

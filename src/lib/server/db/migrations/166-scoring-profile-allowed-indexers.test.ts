import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '../schema-sync.js';
import { MIGRATION_COLUMN_MAP, columnExists } from '../migration-helpers.js';
import { MIGRATIONS } from './index.js';

const databases: Database.Database[] = [];

afterEach(() => databases.splice(0).forEach((sqlite) => sqlite.close()));

describe('migration 166: scoring profile allowed indexers', () => {
	it('is registered in schema and drift metadata', () => {
		expect(MIGRATIONS.find(({ version }) => version === 166)?.name).toMatch(/allowed_indexers/i);
		expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(166);
		expect(MIGRATION_COLUMN_MAP[166]).toEqual([
			{ table: 'scoring_profiles', column: 'allowed_indexers' }
		]);
	});

	it('adds a nullable column idempotently and leaves existing rows unrestricted', () => {
		const sqlite = new Database(':memory:');
		databases.push(sqlite);
		sqlite.exec(`
			CREATE TABLE scoring_profiles (
				id text PRIMARY KEY NOT NULL,
				name text NOT NULL
			)
		`);
		sqlite.prepare(`INSERT INTO scoring_profiles (id, name) VALUES ('balanced', 'Balanced')`).run();

		const migration = MIGRATIONS.find(({ version }) => version === 166)!;
		expect(() => migration.apply(sqlite)).not.toThrow();
		expect(() => migration.apply(sqlite)).not.toThrow();
		expect(columnExists(sqlite, 'scoring_profiles', 'allowed_indexers')).toBe(true);

		// NULL means "all indexers" — upgrading must not change search behavior.
		expect(
			sqlite
				.prepare(`SELECT allowed_indexers FROM scoring_profiles WHERE id = 'balanced'`)
				.pluck()
				.get()
		).toBeNull();
	});
});

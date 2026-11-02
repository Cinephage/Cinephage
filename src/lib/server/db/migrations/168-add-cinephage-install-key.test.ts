import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';

function createPreMigrationDb(): Database.Database {
	const sqlite = new Database(':memory:');
	sqlite
		.prepare(
			`
			CREATE TABLE "cinephage_api_config" (
				"id" integer PRIMARY KEY NOT NULL DEFAULT 1 CHECK ("id" = 1),
				"enabled" integer DEFAULT 1 NOT NULL,
				"base_url" text NOT NULL DEFAULT 'https://api.cinephage.net',
				"version_override" text,
				"commit_override" text,
				"auto_update" integer DEFAULT 1 NOT NULL,
				"latest_version" text,
				"latest_commit" text,
				"updated_at" text
			)
			`
		)
		.run();
	sqlite
		.prepare(
			`INSERT INTO cinephage_api_config (id, enabled, base_url, updated_at) VALUES (1, 1, 'https://api.cinephage.net', ?)`
		)
		.run(new Date().toISOString());
	return sqlite;
}

describe('migration 168: add cinephage install key', () => {
	let sqlite: Database.Database;
	let migration: MigrationDefinition;

	beforeEach(async () => {
		sqlite = createPreMigrationDb();
		const mod = await import('./168-add-cinephage-install-key.js');
		migration = mod.migration_v168;
	});

	it('has version 168', () => {
		expect(migration.version).toBe(168);
	});

	it('adds the install-key columns, all nullable', () => {
		migration.apply(sqlite);
		const columns = sqlite.prepare(`PRAGMA table_info(cinephage_api_config)`).all() as Array<{
			name: string;
			notnull: number;
		}>;
		for (const name of ['install_id', 'api_key', 'api_key_prefix', 'registration_email']) {
			const col = columns.find((c) => c.name === name);
			expect(col, `column ${name}`).toBeDefined();
			expect(col?.notnull).toBe(0);
		}
	});

	it('preserves existing data and is idempotent', () => {
		migration.apply(sqlite);
		migration.apply(sqlite);

		const row = sqlite.prepare(`SELECT * FROM cinephage_api_config WHERE id = 1`).get() as Record<
			string,
			unknown
		>;
		expect(row.base_url).toBe('https://api.cinephage.net');
		expect(row.install_id).toBeNull();
		expect(row.api_key).toBeNull();
	});
});

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';

// We import after defining the schema manually so the migration runs against
// a representative pre-migration database. We don't use createTestDb() because
// it runs syncSchema() which already creates the cinephage_api_* tables and
// fresh-DB migrations - we want to validate the data-move logic specifically.

const CINEPHAGE_STREAM_DEFINITION_ID = 'cinephage-stream';

function createPreMigrationDb(): Database.Database {
	const sqlite = new Database(':memory:');
	// Minimal indexers + cinephage_api tables representing a v102 DB
	sqlite
		.prepare(
			`
			CREATE TABLE "indexers" (
				"id" text PRIMARY KEY NOT NULL,
				"name" text NOT NULL,
				"definition_id" text NOT NULL,
				"enabled" integer DEFAULT true,
				"is_built_in" integer DEFAULT 0 NOT NULL,
				"base_url" text NOT NULL,
				"priority" integer DEFAULT 25,
				"settings" text,
				"protocol_settings" text,
				"created_at" text,
				"updated_at" text
			)
			`
		)
		.run();
	sqlite
		.prepare(
			`
			CREATE TABLE "cinephage_api_config" (
				"id" integer PRIMARY KEY NOT NULL DEFAULT 1 CHECK ("id" = 1),
				"enabled" integer DEFAULT 1 NOT NULL,
				"base_url" text NOT NULL DEFAULT 'https://api.cinephage.net',
				"version_override" text,
				"commit_override" text,
				"updated_at" text
			)
			`
		)
		.run();
	sqlite
		.prepare(
			`
			CREATE TABLE "cinephage_api_modules" (
				"module_id" text PRIMARY KEY NOT NULL,
				"enabled" integer DEFAULT 1 NOT NULL,
				"settings" text NOT NULL DEFAULT '{}',
				"last_error" text,
				"updated_at" text
			)
			`
		)
		.run();
	// Seed singleton config row (migration 101 does this on real DBs)
	sqlite
		.prepare(
			`INSERT INTO cinephage_api_config (id, enabled, base_url, updated_at) VALUES (1, 1, 'https://api.cinephage.net', ?)`
		)
		.run(new Date().toISOString());
	return sqlite;
}

function insertStreamingIndexer(
	sqlite: Database.Database,
	settings: Record<string, unknown> | null
): string {
	const id = 'streaming-row-id';
	sqlite
		.prepare(
			`
			INSERT INTO indexers (id, name, definition_id, enabled, is_built_in, base_url, settings, updated_at)
			VALUES (?, 'Cinephage Library', ?, 1, 1, 'https://api.cinephage.net', ?, ?)
			`
		)
		.run(
			id,
			CINEPHAGE_STREAM_DEFINITION_ID,
			settings ? JSON.stringify(settings) : null,
			new Date().toISOString()
		);
	return id;
}

describe('migration 103: migrate-streaming-settings', () => {
	let sqlite: Database.Database;
	let migration: MigrationDefinition;

	beforeEach(async () => {
		sqlite = createPreMigrationDb();
		const mod = await import('./103-migrate-streaming-settings.js');
		migration = mod.migration_v103;
	});

	it('has version 103', () => {
		expect(migration.version).toBe(103);
	});

	it('moves cinephageVersion/cinephageCommit to cinephage_api_config overrides', () => {
		insertStreamingIndexer(sqlite, {
			cinephageVersion: '2.3.3',
			cinephageCommit: 'abc1234',
			useHttps: 'true',
			externalHost: '192.168.1.100:3000'
		});

		migration.apply(sqlite);

		const config = sqlite
			.prepare(`SELECT version_override, commit_override FROM cinephage_api_config WHERE id = 1`)
			.get() as { version_override: string | null; commit_override: string | null };
		expect(config.version_override).toBe('2.3.3');
		expect(config.commit_override).toBe('abc1234');
	});

	it('moves useHttps/externalHost to library-streaming module settings', () => {
		insertStreamingIndexer(sqlite, {
			cinephageVersion: '2.3.3',
			cinephageCommit: 'abc1234',
			useHttps: 'true',
			externalHost: '192.168.1.100:3000'
		});

		migration.apply(sqlite);

		const module = sqlite
			.prepare(`SELECT settings FROM cinephage_api_modules WHERE module_id = 'library-streaming'`)
			.get() as { settings: string };
		const parsed = JSON.parse(module.settings);
		expect(parsed.useHttps).toBe(true);
		expect(parsed.externalHost).toBe('192.168.1.100:3000');
	});

	it('nulls out the indexer row settings after migration', () => {
		insertStreamingIndexer(sqlite, {
			cinephageVersion: '2.3.3',
			cinephageCommit: 'abc1234'
		});

		migration.apply(sqlite);

		const row = sqlite
			.prepare(`SELECT settings FROM indexers WHERE definition_id = ?`)
			.get(CINEPHAGE_STREAM_DEFINITION_ID) as { settings: string | null };
		// Settings should be empty (null or '{}' - either is acceptable; the
		// indexer row no longer owns any settings after migration).
		expect(row.settings === null || row.settings === '{}').toBe(true);
	});

	it('is idempotent - running twice is a no-op', () => {
		insertStreamingIndexer(sqlite, {
			cinephageVersion: '2.3.3',
			cinephageCommit: 'abc1234',
			useHttps: 'true',
			externalHost: 'foo'
		});

		migration.apply(sqlite);
		// Capture post-first-migration state
		const config1 = sqlite
			.prepare(`SELECT version_override, commit_override FROM cinephage_api_config WHERE id = 1`)
			.get() as { version_override: string | null; commit_override: string | null };
		const module1 = sqlite
			.prepare(`SELECT settings FROM cinephage_api_modules WHERE module_id = 'library-streaming'`)
			.get() as { settings: string };

		// Re-run - should not throw, should not double-write
		migration.apply(sqlite);

		const config2 = sqlite
			.prepare(`SELECT version_override, commit_override FROM cinephage_api_config WHERE id = 1`)
			.get() as { version_override: string | null; commit_override: string | null };
		const module2 = sqlite
			.prepare(`SELECT settings FROM cinephage_api_modules WHERE module_id = 'library-streaming'`)
			.get() as { settings: string };

		expect(config2).toEqual(config1);
		expect(module2).toEqual(module1);
	});

	it('skips overrides that are empty strings', () => {
		// Real-world data may have empty-string values from the old form
		insertStreamingIndexer(sqlite, {
			cinephageVersion: '',
			cinephageCommit: '',
			useHttps: 'false',
			externalHost: ''
		});

		migration.apply(sqlite);

		const config = sqlite
			.prepare(`SELECT version_override, commit_override FROM cinephage_api_config WHERE id = 1`)
			.get() as { version_override: string | null; commit_override: string | null };
		// Empty strings should NOT clobber existing overrides (which were null
		// from migration 101's seed). Subsystem will auto-detect instead.
		expect(config.version_override).toBeNull();
		expect(config.commit_override).toBeNull();
	});

	it('handles missing cinephage-stream row gracefully (fresh install case)', () => {
		// A brand-new install that goes straight to v103 might not have the
		// cinephage-stream indexer row yet - the module will seed it on init.
		// Migration must be a no-op in that case.
		expect(() => migration.apply(sqlite)).not.toThrow();

		const config = sqlite
			.prepare(`SELECT version_override, commit_override FROM cinephage_api_config WHERE id = 1`)
			.get() as { version_override: string | null; commit_override: string | null };
		expect(config.version_override).toBeNull();
		expect(config.commit_override).toBeNull();
	});

	it('handles indexer with null settings gracefully', () => {
		insertStreamingIndexer(sqlite, null);
		expect(() => migration.apply(sqlite)).not.toThrow();
	});

	it('preserves useHttps:false as an explicit false (not dropped)', () => {
		insertStreamingIndexer(sqlite, {
			useHttps: 'false',
			externalHost: 'host:3000'
		});

		migration.apply(sqlite);

		const module = sqlite
			.prepare(`SELECT settings FROM cinephage_api_modules WHERE module_id = 'library-streaming'`)
			.get() as { settings: string };
		const parsed = JSON.parse(module.settings);
		expect(parsed.useHttps).toBe(false);
		expect(parsed.externalHost).toBe('host:3000');
	});

	it('only affects the cinephage-stream row, leaves other indexers alone', () => {
		// Insert cinephage-stream row
		insertStreamingIndexer(sqlite, { cinephageVersion: 'v1', cinephageCommit: 'c1' });
		// Insert unrelated indexer with settings
		sqlite
			.prepare(
				`
				INSERT INTO indexers (id, name, definition_id, enabled, is_built_in, base_url, settings, updated_at)
				VALUES ('other-id', 'Other', 'knaben', 1, 0, 'https://example.com', '{"apiKey":"secret"}', ?)
				`
			)
			.run(new Date().toISOString());

		migration.apply(sqlite);

		const other = sqlite.prepare(`SELECT settings FROM indexers WHERE id = 'other-id'`).get() as {
			settings: string;
		};
		// Other indexer's settings untouched
		expect(JSON.parse(other.settings)).toEqual({ apiKey: 'secret' });
	});
});

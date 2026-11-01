import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { MigrationDefinition } from '../migration-helpers.js';

const RAW_ENVELOPE = 'cphg1.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WRAPPED_ENVELOPE = JSON.stringify(RAW_ENVELOPE);
const OTHER_INDEXER_ENVELOPE = 'cphg1.k1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function createPreMigrationDb(): Database.Database {
	const sqlite = new Database(':memory:');
	sqlite
		.prepare(
			`
			CREATE TABLE "indexer_status" (
				"indexer_id" text PRIMARY KEY NOT NULL,
				"health" text DEFAULT 'unknown',
				"consecutive_failures" integer DEFAULT 0 NOT NULL,
				"total_requests" integer DEFAULT 0 NOT NULL,
				"total_failures" integer DEFAULT 0 NOT NULL,
				"is_disabled" integer DEFAULT 0 NOT NULL,
				"cookies" text,
				"cookies_expiration_date" text,
				"created_at" text NOT NULL,
				"updated_at" text NOT NULL
			)
			`
		)
		.run();
	const insert = sqlite.prepare(
		`INSERT INTO indexer_status (indexer_id, health, cookies, cookies_expiration_date, created_at, updated_at)
		 VALUES (?, 'healthy', ?, ?, ?, ?)`
	);
	const now = new Date().toISOString();
	// What the schema-161 migration / key rotation wrote: raw envelope.
	insert.run('raw-envelope-indexer', RAW_ENVELOPE, '2026-11-05T00:00:00.000Z', now, now);
	// What the old JSON-mode CookieStore path wrote: JSON-encoded envelope.
	insert.run('wrapped-envelope-indexer', WRAPPED_ENVELOPE, '2026-11-30T00:00:00.000Z', now, now);
	// Another indexer's cookie blob must not be touched.
	insert.run('other-indexer', OTHER_INDEXER_ENVELOPE, '2026-12-01T00:00:00.000Z', now, now);
	// Null cookies row: must stay null.
	insert.run('no-cookies-indexer', null, null, now, now);
	return sqlite;
}

describe('migration 169: unwrap JSON-encoded indexer cookie envelopes', () => {
	let sqlite: Database.Database;
	let migration: MigrationDefinition;

	beforeEach(async () => {
		sqlite = createPreMigrationDb();
		const mod = await import('./169-unwrap-json-indexer-cookies.js');
		migration = mod.migration_v169;
	});

	it('has version 169', () => {
		expect(migration.version).toBe(169);
	});

	it('unwraps JSON-encoded envelopes to the raw envelope', () => {
		migration.apply(sqlite);
		const row = sqlite
			.prepare(`SELECT cookies FROM indexer_status WHERE indexer_id = 'wrapped-envelope-indexer'`)
			.get() as { cookies: string };
		expect(row.cookies).toBe(RAW_ENVELOPE);
	});

	it('leaves raw envelopes untouched', () => {
		migration.apply(sqlite);
		for (const id of ['raw-envelope-indexer', 'other-indexer']) {
			const row = sqlite
				.prepare(`SELECT cookies FROM indexer_status WHERE indexer_id = ?`)
				.get(id) as { cookies: string };
			expect(row.cookies).toBe(
				id === 'raw-envelope-indexer' ? RAW_ENVELOPE : OTHER_INDEXER_ENVELOPE
			);
		}
	});

	it('leaves null cookies and other columns alone', () => {
		migration.apply(sqlite);
		const row = sqlite
			.prepare(
				`SELECT cookies, cookies_expiration_date, health FROM indexer_status WHERE indexer_id = 'no-cookies-indexer'`
			)
			.get() as { cookies: string | null; cookies_expiration_date: string | null; health: string };
		expect(row.cookies).toBeNull();
		expect(row.cookies_expiration_date).toBeNull();
		expect(row.health).toBe('healthy');
	});

	it('is idempotent', () => {
		migration.apply(sqlite);
		migration.apply(sqlite);
		const rows = sqlite
			.prepare(`SELECT indexer_id, cookies FROM indexer_status ORDER BY indexer_id`)
			.all() as Array<{ indexer_id: string; cookies: string | null }>;
		const byId = Object.fromEntries(rows.map((r) => [r.indexer_id, r.cookies]));
		expect(byId['wrapped-envelope-indexer']).toBe(RAW_ENVELOPE);
		expect(byId['raw-envelope-indexer']).toBe(RAW_ENVELOPE);
		expect(byId['other-indexer']).toBe(OTHER_INDEXER_ENVELOPE);
		expect(byId['no-cookies-indexer']).toBeNull();
	});
});

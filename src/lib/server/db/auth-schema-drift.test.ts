/**
 * Drift guard for the Better Auth schema copies.
 *
 * The Better Auth table layout exists in three places that must stay in sync:
 * the raw DDL in BETTER_AUTH_TABLE_DEFINITIONS (executed at auth module init
 * to outrun Better Auth 1.7's first-access schema validation latch), the
 * Drizzle mirror in schema.ts (typed access + direct updates), and the
 * schema-sync splice. A column added to one but not the others fails loudly
 * at runtime — the 1.7 latch bricks auth for the process lifetime — so this
 * test fails at compile/test time instead, before anything ships.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getTableColumns } from 'drizzle-orm';
import { BETTER_AUTH_TABLE_DEFINITIONS } from './migration-helpers.js';
import { user, session, account, verification, authApiKeys, authRateLimits } from './schema.js';

const DRIZZLE_MIRROR: Record<string, Parameters<typeof getTableColumns>[0]> = {
	user,
	session,
	account,
	verification,
	apikey: authApiKeys,
	rateLimit: authRateLimits
};

function ddlColumnNames(sqlite: Database.Database, table: string): string[] {
	const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

describe('Better Auth schema drift guard', () => {
	it('BETTER_AUTH_TABLE_DEFINITIONS covers every mirrored Drizzle table', () => {
		const ddlTables = BETTER_AUTH_TABLE_DEFINITIONS.map((definition) => definition.name).sort();
		expect(ddlTables).toEqual(Object.keys(DRIZZLE_MIRROR).sort());
	});

	it.each(BETTER_AUTH_TABLE_DEFINITIONS.map((definition) => [definition.name, definition.sql]))(
		'DDL for %s matches the Drizzle mirror columns',
		(table, sql) => {
			const sqlite = new Database(':memory:');
			try {
				sqlite.exec(sql);

				const ddlColumns = ddlColumnNames(sqlite, table);
				const drizzleColumns = Object.keys(getTableColumns(DRIZZLE_MIRROR[table]));

				expect(ddlColumns.sort()).toEqual(drizzleColumns.sort());
			} finally {
				sqlite.close();
			}
		}
	);
});

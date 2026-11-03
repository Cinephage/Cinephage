import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Normalize indexer session cookies to the raw-envelope at-rest format.
 *
 * `indexer_status.cookies` was declared JSON-mode in drizzle while the
 * schema-161 credential pass (and key rotation) writes plain `cphg1.`
 * envelope strings via raw SQL. Those raw envelopes failed the column's
 * JSON mapping and poisoned every typed read of the table - CookieStore
 * load/save and status loading all threw, losing health state each boot.
 *
 * Schema 169 declares the column plain text (the raw envelope, like every
 * other scalar secret column). This migration unwraps the rows the old
 * app-side CookieStore path had JSON-encoded (a JSON string containing the
 * envelope) so both conventions converge on the raw envelope. Raw envelope
 * rows - exactly what the migration/rotation writers produced - already
 * match the new convention and pass through untouched.
 */
export const migration_v169: MigrationDefinition = {
	version: 169,
	name: 'unwrap_json_indexer_cookies',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`UPDATE "indexer_status"
				 SET "cookies" = json_extract("cookies", '$')
				 WHERE "cookies" LIKE '"cphg1.%'
				   AND json_valid("cookies")
				   AND json_type("cookies") = 'text'`
			)
			.run();
	}
};

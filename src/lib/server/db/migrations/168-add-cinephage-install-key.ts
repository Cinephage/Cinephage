import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists } from '../migration-helpers.js';

/**
 * Add per-install gateway key columns to cinephage_api_config.
 *
 * The api.cinephage.net gateway moved from shared build headers to
 * per-install API keys (2026-10-30 brief): each install registers once with
 * a persistent installId and receives a `ck_...` key that is encrypted at
 * rest (see SECRET_FIELD_SPECS). New columns are all nullable - an install
 * is simply unregistered until the user clicks register.
 */
export const migration_v168: MigrationDefinition = {
	version: 168,
	name: 'add_cinephage_install_key',
	apply: (sqlite) => {
		const columns: Array<[string, string]> = [
			['install_id', 'text'],
			['api_key', 'text'],
			['api_key_prefix', 'text'],
			['registration_email', 'text']
		];
		for (const [name, type] of columns) {
			if (!columnExists(sqlite, 'cinephage_api_config', name)) {
				sqlite.prepare(`ALTER TABLE "cinephage_api_config" ADD COLUMN "${name}" ${type}`).run();
			}
		}
	}
};

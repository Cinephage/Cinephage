import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 158: user_preferences.
 *
 * Per-account preference storage (userId + key + JSON value). Preferences
 * are personal by definition, so nothing here falls back to a global row.
 * As part of this migration the one global-but-personal setting — the
 * calendar preferences blob in the shared settings table — moves to the
 * oldest admin account, since that account was the only one able to write
 * it.
 */
export const migration_v158: MigrationDefinition = {
	version: 158,
	name: 'user_preferences',
	apply: (sqlite) => {
		sqlite
			.prepare(
				`CREATE TABLE IF NOT EXISTS "user_preferences" (
		"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
		"key" text NOT NULL,
		"value" text NOT NULL,
		"updated_at" text,
		PRIMARY KEY ("user_id", "key")
	)`
			)
			.run();

		// Carry the global calendar preferences over to the first admin so
		// the upgrade is invisible to them. Raw JSON copy: the stored shape
		// is exactly what the per-user key stores.
		const globalPrefs = sqlite
			.prepare(`SELECT value FROM settings WHERE key = 'calendar_preferences' LIMIT 1`)
			.get() as { value: string } | undefined;

		if (globalPrefs) {
			const admin = sqlite
				.prepare(`SELECT id FROM user WHERE role = 'admin' ORDER BY createdAt ASC LIMIT 1`)
				.get() as { id: string } | undefined;

			if (admin) {
				sqlite
					.prepare(
						`INSERT OR REPLACE INTO "user_preferences" ("user_id", "key", "value", "updated_at")
						VALUES (?, 'calendar', ?, ?)`
					)
					.run(admin.id, globalPrefs.value, new Date().toISOString());
			}

			sqlite.prepare(`DELETE FROM settings WHERE key = 'calendar_preferences'`).run();
		}
	}
};

import type { MigrationDefinition } from '../migration-helpers.js';

// Hardcoded (not imported from #lib/server/indexers/types) so migrations stay
// decoupled from app code. See migration 102 for the same convention.
const CINEPHAGE_STREAM_DEFINITION_ID = 'cinephage-stream';
const LIBRARY_STREAMING_MODULE_ID = 'library-streaming';

/**
 * Migration 103: Move streaming settings out of the indexer row's settings JSON.
 *
 * Before: indexers.settings for the cinephage-stream row held
 *   { useHttps, externalHost, cinephageCommit, cinephageVersion }
 *
 * After:
 *   - cinephage_api_config.version_override / commit_override hold the manual
 *     version/commit escape-hatch values (null on a fresh install — subsystem
 *     auto-detects from APP_VERSION / APP_COMMIT env vars)
 *   - cinephage_api_modules.settings for 'library-streaming' holds
 *     { useHttps: boolean, externalHost: string }
 *   - The indexer row's settings JSON is wiped clean
 *
 * Idempotent: re-running is a no-op (source JSON is empty after first run).
 */
export const migration_v103: MigrationDefinition = {
	version: 103,
	name: 'migrate_streaming_settings',
	apply: (sqlite) => {
		// Read the cinephage-stream row's settings JSON. If the row doesn't
		// exist yet (fresh install path), there's nothing to migrate.
		const row = sqlite
			.prepare(`SELECT settings FROM indexers WHERE definition_id = ?`)
			.get(CINEPHAGE_STREAM_DEFINITION_ID) as { settings: string | null } | undefined;

		if (!row) {
			// No cinephage-stream indexer row yet — module will seed it on init.
			return;
		}

		const rawSettings = row.settings ? JSON.parse(row.settings) : null;
		if (!rawSettings || typeof rawSettings !== 'object') {
			// Already migrated (or never set) — nothing to do.
			return;
		}

		// Extract values — be tolerant of strings/booleans and empty strings
		// (the old form submitted empty strings for unfilled fields).
		const versionOverride = pickNonEmptyString(rawSettings.cinephageVersion);
		const commitOverride = pickNonEmptyString(rawSettings.cinephageCommit);
		const externalHost = pickNonEmptyString(rawSettings.externalHost);
		const useHttps = parseUseHttps(rawSettings.useHttps);

		// 1. Move version/commit overrides into the subsystem config singleton.
		//    Only clobber existing values when we have a real value to write
		//    (skip empty strings so we don't blow away a previously-valid override).
		if (versionOverride) {
			sqlite
				.prepare(`UPDATE cinephage_api_config SET version_override = ? WHERE id = 1`)
				.run(versionOverride);
		}
		if (commitOverride) {
			sqlite
				.prepare(`UPDATE cinephage_api_config SET commit_override = ? WHERE id = 1`)
				.run(commitOverride);
		}

		// 2. Move useHttps/externalHost into the library-streaming module row.
		//    Merge with any existing module settings to avoid losing other fields.
		const existingModule = sqlite
			.prepare(`SELECT settings FROM cinephage_api_modules WHERE module_id = ?`)
			.get(LIBRARY_STREAMING_MODULE_ID) as { settings: string } | undefined;

		const existingSettings =
			existingModule && existingModule.settings
				? (JSON.parse(existingModule.settings) as Record<string, unknown>)
				: {};

		const merged: Record<string, unknown> = { ...existingSettings };
		// Always write useHttps (it has a meaningful default of false; preserve
		// the user's previous choice even if it was the default).
		merged.useHttps = useHttps;
		// Only set externalHost when we have a real value — otherwise leave
		// any existing value intact (could have been set by an earlier migration
		// attempt or by the module itself).
		if (externalHost) {
			merged.externalHost = externalHost;
		}

		const now = new Date().toISOString();
		sqlite
			.prepare(
				`
				INSERT INTO cinephage_api_modules (module_id, enabled, settings, updated_at)
				VALUES (?, 1, ?, ?)
				ON CONFLICT(module_id) DO UPDATE SET settings = ?, updated_at = ?
				`
			)
			.run(LIBRARY_STREAMING_MODULE_ID, JSON.stringify(merged), now, JSON.stringify(merged), now);

		// 3. Null out the source JSON so the indexer row is no longer a source
		//    of truth for any settings. Future reads go through the subsystem.
		sqlite
			.prepare(`UPDATE indexers SET settings = NULL WHERE definition_id = ?`)
			.run(CINEPHAGE_STREAM_DEFINITION_ID);
	}
};

function pickNonEmptyString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseUseHttps(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value !== 'string') return false;
	const normalized = value.trim().toLowerCase();
	return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

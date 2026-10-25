import { resolveAppVersion as resolveAppVersionBase } from '#lib/server/version.js';

/**
 * Cinephage subsystem version resolution.
 *
 * The running Cinephage server knows its own version (and ideally its commit,
 * baked into the Docker image at build time). This module exposes that identity
 * for use as X-Cinephage-Version / X-Cinephage-Commit headers when calling
 * api.cinephage.net. Users no longer have to populate these manually.
 *
 * Resolution chain (per field):
 *   1. Manual override from cinephage_api_config (escape hatch for custom builds)
 *   2. Auto-synced latest release (cinephage_api_config.latest_version/commit),
 *      kept fresh by the identity sync — the api.cinephage.net gateway only
 *      accepts the newest published release pair.
 *   3. APP_VERSION / APP_COMMIT env vars (baked into Dockerfile at build)
 *   4. null — subsystem reports "not configured" and test() fails clearly
 *
 * `resolveAppVersion` reuses the existing helper at src/lib/server/version.ts
 * to stay consistent with the rest of the app.
 */

const PLACEHOLDER_VALUES = new Set(['0.0.0-development', '0.1.0', '0.0.0']);

function normalizeString(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	if (PLACEHOLDER_VALUES.has(trimmed)) return null;
	return trimmed;
}

export function resolveAppVersion(): string {
	// Reuses the canonical resolver; falls back to 'dev-local' for dev checkouts.
	return resolveAppVersionBase();
}

export function resolveAppCommit(): string | null {
	return normalizeString(process.env.APP_COMMIT);
}

export interface CinephageServerIdentity {
	/** Resolved version string. Always set (falls back to 'dev-local'). */
	version: string;
	/** Resolved commit short-SHA. Null when no source yields a commit. */
	commit: string | null;
	/** True when both version and commit are non-placeholder. Required for API calls. */
	isConfigured: boolean;
}

export function getServerIdentity(input: {
	versionOverride: string | null;
	commitOverride: string | null;
	latestVersion: string | null;
	latestCommit: string | null;
}): CinephageServerIdentity {
	const version =
		normalizeString(input.versionOverride) ??
		normalizeString(input.latestVersion) ??
		resolveAppVersion();
	const commit =
		normalizeString(input.commitOverride) ??
		normalizeString(input.latestCommit) ??
		resolveAppCommit();

	return {
		version,
		commit,
		isConfigured: Boolean(version) && Boolean(commit) && !PLACEHOLDER_VALUES.has(version)
	};
}

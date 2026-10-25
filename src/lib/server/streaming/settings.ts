/**
 * Streaming settings — thin compatibility shim.
 *
 * Historically this module read the cinephage-stream indexer row's `settings`
 * JSON to derive useHttps/externalHost/version/commit. After the CinephageAPI
 * subsystem overhaul (Phase 2), the canonical source of truth is:
 *   - useHttps / externalHost → cinephage_api_modules.settings.library-streaming
 *   - version / commit       → cinephage_api_config.version_override/commit_override
 *                              (or auto-detected from APP_VERSION/APP_COMMIT env)
 *
 * This file remains as a backward-compat shim so existing consumers
 * (streaming/url.ts, StreamingHandler.ts, NzbStreamingHandler.ts,
 * CinephageApiService.ts [until Phase 3], IPTV provider + countries route
 * [until a future IPTV module]) keep working without per-consumer rewrites.
 *
 * New code should read from the cinephage subsystem directly:
 *   - getCinephageSettingsService().getConfig() for subsystem config
 *   - getCinephageCore().getIdentity() for version/commit
 *   - getCinephageModuleRegistry().getById('library-streaming') for module settings
 */

import { getCinephageSettingsService } from '#lib/server/cinephage/settings/CinephageSettingsService.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';

export interface StreamingIndexerSettings {
	/** Whether to use HTTPS (string-typed for legacy callers) */
	useHttps?: 'true' | 'false';
	/** External host:port */
	externalHost?: string;
	/** Resolved base URL (https?://host) */
	baseUrl?: string;
	/** Build commit (resolved from override or APP_COMMIT env) */
	cinephageCommit?: string;
	/** Build version (resolved from override or APP_VERSION env) */
	cinephageVersion?: string;
}

/**
 * Get the resolved streaming settings from the CinephageAPI subsystem.
 *
 * Returns undefined only if the subsystem is unavailable (which shouldn't
 * happen post-boot). All four legacy fields are populated from their new
 * canonical locations.
 */
export async function getStreamingIndexerSettings(): Promise<StreamingIndexerSettings | undefined> {
	const settingsService = getCinephageSettingsService();
	const core = getCinephageCore();

	const [subsystemCfg, moduleCfg, identity] = await Promise.all([
		settingsService.getConfig(),
		settingsService.getModuleConfig('library-streaming'),
		core.getIdentity()
	]);

	// Module settings shape is validated by LibraryStreamingModule's schema.
	const useHttps = Boolean(moduleCfg.settings?.useHttps);
	const externalHost =
		typeof moduleCfg.settings?.externalHost === 'string'
			? (moduleCfg.settings.externalHost as string)
			: '';

	const result: StreamingIndexerSettings = {
		useHttps: useHttps ? 'true' : 'false',
		externalHost: externalHost || undefined,
		cinephageVersion: identity.version,
		cinephageCommit: identity.commit ?? undefined
	};

	if (externalHost) {
		const host = externalHost.replace(/^https?:\/\//, '');
		const protocol = useHttps ? 'https' : 'http';
		result.baseUrl = `${protocol}://${host}`;
	}

	// Mark subsystem-unavailable for callers that depend on .configured
	if (!subsystemCfg.enabled) {
		return undefined;
	}

	return result;
}

/**
 * Get the base URL for streaming, with fallback chain:
 * 1. Cinephage subsystem library-streaming module (useHttps + externalHost)
 * 2. PUBLIC_BASE_URL environment variable
 * 3. Provided fallback (usually from request headers)
 */
export async function getStreamingBaseUrl(fallback: string): Promise<string> {
	const settings = await getStreamingIndexerSettings();

	if (settings?.baseUrl) {
		return settings.baseUrl.replace(/\/$/, '');
	}

	const envUrl = process.env.PUBLIC_BASE_URL;
	if (envUrl) {
		return envUrl.replace(/\/$/, '');
	}

	return fallback;
}

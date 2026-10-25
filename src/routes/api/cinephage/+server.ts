import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getCinephageSettingsService } from '#lib/server/cinephage/settings/CinephageSettingsService.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';
import { getCinephageModuleRegistry } from '#lib/server/cinephage/registry/CinephageModuleRegistry.js';
import { LibraryStreamingModule } from '#lib/server/cinephage/modules/library-streaming/LibraryStreamingModule.js';

/**
 * Static module metadata for the UI. Mirrors the metadata declared on each
 * module class. We hard-code the list here rather than reading it from the
 * registry, because the registry may be empty during early init (e.g. a
 * fresh boot where CinephageApiService hasn't run yet) and the UI still
 * needs to render the module card.
 *
 * Keep in sync with the modules in src/lib/server/cinephage/modules/index.ts.
 */
const STATIC_MODULE_METADATA = [
	{
		moduleId: LibraryStreamingModule.prototype.id,
		name: LibraryStreamingModule.prototype.name,
		description: LibraryStreamingModule.prototype.description,
		maturity: LibraryStreamingModule.prototype.maturity,
		capabilities: LibraryStreamingModule.prototype.capabilities
	}
] as const;

/**
 * GET /api/cinephage
 * Returns the full CinephageAPI subsystem state: config, resolved identity,
 * and per-module state. Admin-gated. Used by the settings panel's load.
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const settings = getCinephageSettingsService();
	const core = getCinephageCore();
	const registry = getCinephageModuleRegistry();

	const [config, identity] = await Promise.all([settings.getConfig(), core.getIdentity()]);

	// Pull module state from settings. Static metadata comes from the
	// registered classes; per-module enabled/settings/lastError from the DB.
	const modules = await Promise.all(
		STATIC_MODULE_METADATA.map(async (meta) => {
			const moduleState = await settings.getModuleConfig(meta.moduleId);
			const registered = registry.getById(meta.moduleId);
			return {
				moduleId: meta.moduleId,
				name: meta.name,
				description: meta.description,
				maturity: meta.maturity,
				enabled: moduleState.enabled,
				settings: moduleState.settings,
				lastError: moduleState.lastError,
				capabilities: meta.capabilities,
				// Effective enabled = subsystem enabled AND module enabled AND
				// (when the module is registered) module.isEnabled() concurs.
				effectiveEnabled:
					config.enabled && moduleState.enabled && (registered ? registered.isEnabled() : true)
			};
		})
	);

	return Response.json({
		success: true,
		config: {
			enabled: config.enabled,
			baseUrl: config.baseUrl,
			versionOverride: config.versionOverride,
			commitOverride: config.commitOverride,
			autoUpdate: config.autoUpdate,
			latestVersion: config.latestVersion,
			latestCommit: config.latestCommit
		},
		identity: {
			version: identity.version,
			commit: identity.commit,
			isConfigured: identity.isConfigured
		},
		modules
	});
};

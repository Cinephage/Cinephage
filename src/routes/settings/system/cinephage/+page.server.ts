import type { PageServerLoad } from './$types';
import { getCinephageSettingsService } from '#lib/server/cinephage/settings/CinephageSettingsService.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';
import { getCinephageModuleRegistry } from '#lib/server/cinephage/registry/CinephageModuleRegistry.js';

export const load: PageServerLoad = async () => {
	const settings = getCinephageSettingsService();
	const core = getCinephageCore();
	const registry = getCinephageModuleRegistry();

	const [config, identity] = await Promise.all([settings.getConfig(), core.getIdentity()]);

	const moduleMetadata = registry.getAll().map((m) => ({
		moduleId: m.id,
		name: m.name,
		description: m.description,
		maturity: m.maturity,
		capabilities: m.capabilities
	}));

	const modules = await Promise.all(
		moduleMetadata.map(async (meta) => {
			const mod = await settings.getModuleConfig(meta.moduleId);
			const registered = registry.getById(meta.moduleId);
			return {
				...meta,
				enabled: mod.enabled,
				settings: mod.settings,
				lastError: mod.lastError,
				effectiveEnabled:
					config.enabled && mod.enabled && (registered ? registered.isEnabled() : true)
			};
		})
	);

	return {
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
	};
};

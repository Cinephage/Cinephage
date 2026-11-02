import type { PageServerLoad } from './$types';
import { getSubtitleProviderManager } from '#lib/server/subtitles/services/SubtitleProviderManager.js';
import { ensureProvidersRegistered } from '#lib/server/subtitles/providers/registry.js';

export const load: PageServerLoad = async () => {
	await ensureProvidersRegistered();

	const manager = getSubtitleProviderManager();
	const providers = await manager.getProviders();
	const definitions = manager.getDefinitions();

	return {
		providers: providers.map((provider) => ({
			...provider,
			definitionName: definitions.find((d) => d.implementation === provider.implementation)?.name,
			definition: definitions.find((d) => d.implementation === provider.implementation)
		})),
		definitions
	};
};

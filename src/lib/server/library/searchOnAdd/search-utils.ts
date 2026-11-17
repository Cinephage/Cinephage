/**
 * Search On Add - shared utilities and constants
 */

import {
	CINEPHAGE_STREAM_DEFINITION_ID,
	indexerHasCategoriesForSearchType
} from '#lib/server/indexers/types/index.js';
import type { IndexerCapabilities, IndexerConfig } from '#lib/server/indexers/types/index.js';

export const AUTO_GRAB_MIN_SCORE = 0;

export function resolveAutoMissingSearchStrategy(
	indexerConfigs: IndexerConfig[],
	options: {
		searchSource: 'interactive' | 'automatic';
		scoringProfileId?: string | null;
		getDefinitionCapabilities: (definitionId: string) => IndexerCapabilities | undefined;
		getDefinitionFeatures: (definitionId: string) => { livingSeasonPacks?: boolean } | undefined;
	}
): 'pack-first' | 'episode-only' {
	const isStreamerProfile = options.scoringProfileId === 'streamer';
	const profileScoped = isStreamerProfile
		? indexerConfigs.filter((config) => config.definitionId === CINEPHAGE_STREAM_DEFINITION_ID)
		: indexerConfigs;

	const eligibleTvIndexers = profileScoped.filter((config) => {
		if (!config.enabled) return false;
		if (options.searchSource === 'interactive' && config.enableInteractiveSearch === false)
			return false;
		if (options.searchSource === 'automatic' && config.enableAutomaticSearch === false)
			return false;

		const capabilities = options.getDefinitionCapabilities(config.definitionId);
		return Boolean(
			capabilities?.tvSearch?.available &&
			indexerHasCategoriesForSearchType(capabilities.categories, 'tv')
		);
	});

	// A living-season-pack tracker needs episode-targeted searches to fill a
	// snapshot pack; the definition says which trackers those are.
	const isLivingSeasonPackIndexer = (config: IndexerConfig) =>
		options.getDefinitionFeatures(config.definitionId)?.livingSeasonPacks === true;

	const hasLivingSeasonPacks = eligibleTvIndexers.some(isLivingSeasonPackIndexer);
	const hasPlainIndexers = eligibleTvIndexers.some((config) => !isLivingSeasonPackIndexer(config));

	return hasLivingSeasonPacks && !hasPlainIndexers ? 'episode-only' : 'pack-first';
}

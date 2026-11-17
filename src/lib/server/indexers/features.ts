/**
 * Definition-declared indexer behaviour.
 *
 * The runtime used to recognise RuTracker and Kinozal by indexer name or base
 * URL. That breaks exactly where it matters: behind Prowlarr or Jackett the base
 * URL is the proxy's (`.../prowlarr/<id>`), so a host test silently switched the
 * specialised season-pack path off for the users who route through a proxy, and
 * a renamed mirror or instance switched it off again.
 *
 * A definition declares what its tracker does; the runtime asks the definition.
 * The flags live in the YAML (`features:`), the schema is `indexerFeaturesSchema`.
 */

import { createChildLogger } from '#lib/logging/index.js';
import { getIndexerManager } from './IndexerManager.js';
import type { IndexerFeatures, YamlDefinition } from './schema/yamlDefinition.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/** Every flag resolved, with the conservative answer for anything undeclared. */
export type ResolvedIndexerFeatures = Required<IndexerFeatures>;

export const NO_INDEXER_FEATURES: ResolvedIndexerFeatures = {
	livingSeasonPacks: false,
	forumDownloadLinks: false
};

/** Resolve the flags of a loaded definition; anything undeclared is off. */
export function resolveFeatures(
	definition: YamlDefinition | undefined | null
): ResolvedIndexerFeatures {
	const declared = definition?.features;
	if (!declared) return { ...NO_INDEXER_FEATURES };

	return {
		livingSeasonPacks: declared.livingSeasonPacks === true,
		forumDownloadLinks: declared.forumDownloadLinks === true
	};
}

/**
 * Features of the definition an indexer instance is based on.
 *
 * Deliberately tolerant: an indexer whose definition cannot be read keeps the
 * plain behaviour rather than failing the search - but it says so, because a
 * silent "no features" is the same failure the name matching had.
 */
export async function getIndexerFeatures(
	indexerId: string | null | undefined
): Promise<ResolvedIndexerFeatures> {
	if (!indexerId) return { ...NO_INDEXER_FEATURES };

	try {
		const manager = await getIndexerManager();
		const config = await manager.getIndexer(indexerId);
		if (!config) return { ...NO_INDEXER_FEATURES };
		return resolveFeatures(manager.getDefinition(config.definitionId));
	} catch (error) {
		logger.warn(
			{ err: error, indexerId },
			'Could not resolve indexer features; using plain behaviour'
		);
		return { ...NO_INDEXER_FEATURES };
	}
}

/**
 * Features for several indexers at once, keyed by instance id. Release-level
 * filters need one map instead of an await per release.
 */
export async function getFeaturesByIndexerId(
	indexerIds: Array<string | null | undefined>
): Promise<Map<string, ResolvedIndexerFeatures>> {
	const unique = [...new Set(indexerIds.filter((id): id is string => Boolean(id)))];
	const entries = await Promise.all(
		unique.map(async (id) => [id, await getIndexerFeatures(id)] as const)
	);
	return new Map(entries);
}

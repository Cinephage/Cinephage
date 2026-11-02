import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { toUIDefinition } from '#lib/server/indexers/loader/index.js';

/**
 * GET /api/indexers/definitions
 * Returns all available indexer definitions from the unified YAML-based system.
 * Internal/auto-managed definitions (flagged `internal: true` in their YAML,
 * e.g. cinephage-stream) are excluded from this list — they are seeded by
 * their owning subsystem and surfaced on the indexers page as read-only.
 */
export async function GET() {
	const manager = await getIndexerManager();

	// Get all definitions and convert to UI format
	const allDefinitions = manager.getUnifiedDefinitions();

	// Map to API response format, excluding internal definitions
	const definitions = allDefinitions
		.filter((def) => !def.internal)
		.map((def) => {
			const uiDef = toUIDefinition(def);
			return {
				id: uiDef.id,
				name: uiDef.name,
				description: uiDef.description,
				type: uiDef.type,
				protocol: uiDef.protocol,
				siteUrl: uiDef.siteUrl,
				alternateUrls: uiDef.alternateUrls,
				capabilities: uiDef.capabilities,
				settings: uiDef.settings,
				isCustom: uiDef.isCustom
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	return Response.json(definitions);
}

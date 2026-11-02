import type { RequestHandler } from './$types';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { toUIDefinition } from '#lib/server/indexers/loader/index.js';

/**
 * GET /api/indexers/definitions/:id
 * Returns a specific indexer definition (native or Cardigann).
 */
export const GET: RequestHandler = async ({ params }) => {
	const manager = await getIndexerManager();
	const definition = manager.getUnifiedDefinition(params.id);

	if (!definition) {
		return Response.json({ error: 'Definition not found' }, { status: 404 });
	}

	// Convert to UI format for consistent response
	const uiDef = toUIDefinition(definition);

	return Response.json({
		id: uiDef.id,
		name: uiDef.name,
		description: uiDef.description ?? `${uiDef.name} torrent indexer`,
		type: uiDef.type,
		language: definition.language,
		encoding: 'UTF-8',
		protocol: uiDef.protocol,
		siteUrl: uiDef.siteUrl,
		alternateUrls: uiDef.alternateUrls,
		capabilities: uiDef.capabilities,
		settings: uiDef.settings,
		isCustom: uiDef.isCustom
	});
};

import type { RequestHandler } from './$types';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { CINEPHAGE_STREAM_DEFINITION_ID } from '#lib/server/indexers/types/index.js';
import { indexerUpdateSchema } from '#lib/validation/schemas.js';
import { mergeBlankSensitiveIndexerSettings } from '#lib/server/indexers/settingsSecrets.js';
import { createChildLogger } from '#lib/logging/index.js';
import { assertFound, parseBody } from '#lib/server/api/validate.js';
import { NotFoundError } from '#lib/errors/index.js';
import { redactIndexer } from '#lib/server/utils/redaction.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'IndexerAPI' });

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	const manager = await getIndexerManager();
	const indexer = assertFound(await manager.getIndexer(params.id), 'Indexer', params.id);

	return Response.json(redactIndexer(indexer));
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	const manager = await getIndexerManager();

	try {
		await manager.deleteIndexer(params.id);
		return Response.json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Built-in indexer delete attempts return a clear 403.
		if (message.includes('built-in indexer')) {
			return Response.json({ error: message }, { status: 403 });
		}
		if (message.includes('not found')) {
			throw new NotFoundError('Indexer', params.id);
		}
		throw error;
	}
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	const validated = await parseBody(request, indexerUpdateSchema);
	const manager = await getIndexerManager();

	// Get existing indexer to compare settings (for detecting baseUrl changes)
	const existingIndexer = assertFound(await manager.getIndexer(params.id), 'Indexer', params.id);

	// Check if this is the streaming indexer and capture old baseUrl
	const isStreamingIndexer = existingIndexer.definitionId === CINEPHAGE_STREAM_DEFINITION_ID;
	const oldBaseUrl = existingIndexer.baseUrl;
	const newBaseUrl = validated.baseUrl;
	const definition = manager
		.getUnifiedDefinitions()
		.find((d) => d.id === existingIndexer.definitionId);
	// Note: built-in indexers (cinephage-stream) have their settings managed
	// by the CinephageAPI subsystem; the IndexerManager.updateIndexer guard
	// rejects attempts to edit restricted fields. For non-built-in indexers,
	// merge blank sensitive settings normally.
	const settings =
		validated.settings === undefined
			? undefined
			: mergeBlankSensitiveIndexerSettings(
					validated.settings,
					existingIndexer.settings,
					definition?.settings
				);

	try {
		const updated = await manager.updateIndexer(params.id, {
			name: validated.name,
			enabled: validated.enabled,
			orphaned: validated.orphaned,
			baseUrl: validated.baseUrl,
			alternateUrls: validated.alternateUrls,
			priority: validated.priority,
			rateLimitPerMinute: validated.rateLimitPerMinute,
			settings,

			// Search capability toggles
			enableAutomaticSearch: validated.enableAutomaticSearch,
			enableInteractiveSearch: validated.enableInteractiveSearch,

			// Torrent seeding settings
			minimumSeeders: validated.minimumSeeders,
			seedRatio: validated.seedRatio,
			seedTime: validated.seedTime,
			packSeedTime: validated.packSeedTime,
			rejectDeadTorrents: validated.rejectDeadTorrents,

			// Usenet settings
			rejectPasswordProtected: validated.rejectPasswordProtected,
			minimumCompletionPercentage: validated.minimumCompletionPercentage,

			// Newznab/Torznab category overrides
			additionalCategories: validated.additionalCategories
		});

		// If streaming indexer's baseUrl changed, trigger bulk .strm file update.
		// In practice this path is dead after Phase 2 — cinephage-stream's baseUrl
		// is owned by the subsystem and rejected by updateIndexer's guard. The
		// subsystem's own settings endpoint triggers the strm update instead.
		// Kept defensively in case of legacy callers.
		if (isStreamingIndexer && newBaseUrl && oldBaseUrl !== newBaseUrl) {
			logger.info(
				{
					oldBaseUrl,
					newBaseUrl
				},
				'[IndexerAPI] Streaming baseUrl changed, triggering .strm file update'
			);

			// Run in background to not block the response
			import('#lib/server/streaming/index.js')
				.then(async ({ strmService, getStreamingBaseUrl }) => {
					const baseUrl = await getStreamingBaseUrl(newBaseUrl);
					const result = await strmService.bulkUpdateStrmUrls(baseUrl);
					logger.info(
						{
							totalFiles: result.totalFiles,
							updatedFiles: result.updatedFiles,
							errors: result.errors.length
						},
						'[IndexerAPI] Background .strm update complete'
					);
				})
				.catch((err) => {
					logger.error(
						{
							error: err instanceof Error ? err.message : 'Unknown error'
						},
						'[IndexerAPI] Failed to update .strm files after baseUrl change'
					);
				});
		}

		return Response.json({ success: true, indexer: redactIndexer(updated) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('built-in indexer') || message.includes('restricted field')) {
			return Response.json({ error: message }, { status: 403 });
		}
		if (message.includes('not found')) {
			throw new NotFoundError('Indexer', params.id);
		}
		throw error;
	}
};

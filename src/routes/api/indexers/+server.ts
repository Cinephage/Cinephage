import type { RequestHandler } from './$types';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { indexerCreateSchema } from '#lib/validation/schemas.js';
import { redactIndexer } from '#lib/server/utils/redaction.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';

/**
 * GET /api/indexers
 * List all configured indexers.
 * Note: API keys are redacted for security.
 */
export const GET: RequestHandler = async () => {
	const manager = await getIndexerManager();
	const all = await manager.getIndexers();

	// Redact sensitive settings (api keys, passwords, cookies)
	const redactedIndexers = all.map(redactIndexer);

	return Response.json(redactedIndexers);
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	const validated = await parseBody(request, indexerCreateSchema);

	const manager = await getIndexerManager();

	// Verify the definition exists
	const definition = manager.getDefinition(validated.definitionId);
	if (!definition) {
		return Response.json(
			{
				error: 'Invalid definition',
				details: `Unknown indexer definition: ${validated.definitionId}`
			},
			{ status: 400 }
		);
	}

	// Reject creating indexers from internal/auto-managed definitions
	// (e.g. cinephage-stream). These are seeded by their owning subsystem.
	if (definition.internal) {
		return Response.json(
			{
				error: 'Cannot create indexer from internal definition',
				details: `Definition '${validated.definitionId}' is auto-managed by a built-in subsystem and cannot be created manually.`
			},
			{ status: 400 }
		);
	}

	const created = await manager.createIndexer({
		name: validated.name,
		definitionId: validated.definitionId,
		baseUrl: validated.baseUrl,
		alternateUrls: validated.alternateUrls,
		enabled: validated.enabled,
		priority: validated.priority,
		rateLimitPerMinute: validated.rateLimitPerMinute ?? null,
		settings: (validated.settings ?? {}) as Record<string, string>,

		// Search capability toggles
		enableAutomaticSearch: validated.enableAutomaticSearch,
		enableInteractiveSearch: validated.enableInteractiveSearch,

		// Torrent seeding settings (stored in protocolSettings)
		minimumSeeders: validated.minimumSeeders,
		seedRatio: validated.seedRatio ?? null,
		seedTime: validated.seedTime ?? null,
		packSeedTime: validated.packSeedTime ?? null,

		// Usenet settings (stored in protocolSettings)
		rejectPasswordProtected: validated.rejectPasswordProtected,
		minimumCompletionPercentage: validated.minimumCompletionPercentage
	});

	return Response.json({ success: true, indexer: redactIndexer(created) });
};

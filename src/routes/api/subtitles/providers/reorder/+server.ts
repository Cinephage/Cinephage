import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getSubtitleProviderManager } from '#lib/server/subtitles/services/SubtitleProviderManager.js';
import { createChildLogger } from '#lib/logging/index.js';
import { parseBody } from '#lib/server/api/validate.js';

const logger = createChildLogger({ module: 'SubtitleProviderReorderApi', logDomain: 'subtitles' });

/**
 * Schema for reordering providers
 */
const reorderSchema = z.object({
	/** Array of provider IDs in the new priority order (first = highest priority) */
	providerIds: z.array(z.string().uuid()).min(1, 'At least one provider ID is required')
});

/**
 * POST /api/subtitles/providers/reorder
 * Reorder subtitle providers by setting their priority values.
 * The first provider in the array gets priority 1, second gets 2, etc.
 */
export const POST: RequestHandler = async ({ request }) => {
	const { providerIds } = await parseBody(request, reorderSchema);
	const providerManager = getSubtitleProviderManager();

	// Verify all providers exist
	const existingProviders = await providerManager.getProviders();
	const existingIds = new Set(existingProviders.map((p) => p.id));

	for (const id of providerIds) {
		if (!existingIds.has(id)) {
			return Response.json({ error: `Provider not found: ${id}` }, { status: 404 });
		}
	}

	// Update priorities
	const updates: Array<{ id: string; priority: number }> = [];
	for (let i = 0; i < providerIds.length; i++) {
		updates.push({ id: providerIds[i], priority: i + 1 });
	}

	// Apply updates
	for (const update of updates) {
		await providerManager.updateProvider(update.id, { priority: update.priority });
	}

	logger.info(
		{
			count: updates.length,
			order: providerIds
		},
		'[ProviderReorder] Reordered provider priorities'
	);

	return Response.json({
		success: true,
		updated: updates.length
	});
};

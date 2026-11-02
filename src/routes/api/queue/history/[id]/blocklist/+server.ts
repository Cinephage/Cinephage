import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { downloadHistory } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'QueueHistoryBlocklistApi', logDomain: 'downloads' });

/**
 * POST - Manually blocklist the release behind a download history record.
 *
 * Unlike the queue DELETE `?blocklist=true` option, this works for history
 * entries that no longer have a live queue row (e.g. the user retried, or
 * the item was already removed) - the most common case for a FAILED item a
 * user is looking at in Activity > History.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const { id } = params;

	try {
		const historyItem = await db
			.select()
			.from(downloadHistory)
			.where(eq(downloadHistory.id, id))
			.get();

		if (!historyItem) {
			throw error(404, 'History item not found');
		}

		const { blocklistService } =
			await import('#lib/server/monitoring/specifications/BlocklistSpecification.js');
		const blocklistId = blocklistService.addToBlocklist(
			{
				title: historyItem.title,
				infoHash: historyItem.infoHash ?? undefined,
				indexerId: historyItem.indexerId ?? undefined,
				quality: historyItem.quality ?? undefined,
				size: historyItem.size ?? undefined,
				protocol: historyItem.protocol ?? undefined
			},
			{
				movieId: historyItem.movieId ?? undefined,
				seriesId: historyItem.seriesId ?? undefined,
				episodeIds: historyItem.episodeIds ?? undefined,
				reason: 'manual',
				message: 'Manually blocklisted from history'
			}
		);

		return Response.json({ success: true, blocklistId });
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		logger.error('Error blocklisting history item', err instanceof Error ? err : undefined);
		throw error(500, 'Failed to add release to blocklist');
	}
};

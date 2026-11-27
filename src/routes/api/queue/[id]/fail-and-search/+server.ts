import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { downloadQueue } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getDownloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QueueFailAndSearchApi', logDomain: 'downloads' });

/** Statuses in which a download is still trying to finish. */
const ACTIVE = new Set(['queued', 'downloading', 'stalled', 'paused']);

/**
 * POST /api/queue/:id/fail-and-search
 *
 * "This download will not finish": remove it from the client with its files,
 * mark it failed, blocklist the release, and search again right away for just
 * its movie or episodes (in the background; the response does not wait for it).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const item = await db.select().from(downloadQueue).where(eq(downloadQueue.id, params.id)).get();
	if (!item) {
		return Response.json({ success: false, error: 'Queue item not found' }, { status: 404 });
	}
	if (!ACTIVE.has(item.status) || item.protocol === 'debrid') {
		return Response.json(
			{ success: false, error: `Cannot fail a download with status: ${item.status}` },
			{ status: 400 }
		);
	}

	try {
		const done = await getDownloadMonitor().failBlocklistAndSearch(item.id);
		if (!done) {
			return Response.json(
				{ success: false, error: 'Could not reach the download client; nothing was changed' },
				{ status: 502 }
			);
		}
		return Response.json({ success: true });
	} catch (err) {
		logger.error({ queueId: item.id, err }, 'Fail and search failed');
		return Response.json(
			{ success: false, error: 'Failed to mark download failed' },
			{ status: 500 }
		);
	}
};

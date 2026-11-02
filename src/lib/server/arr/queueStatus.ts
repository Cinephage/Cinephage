/**
 * Radarr/Sonarr-compatible `queue/status` response - a lightweight summary
 * (counts + error/warning flags) that arr-satellite clients (observed:
 * NZBDav) poll frequently, separate from the full `/queue` listing.
 *
 * Field set confirmed against QueueStatusResource in Radarr/Sonarr's
 * actual openapi.json. Scoped by media type via movieId/seriesId, the
 * same split every other endpoint here uses; "active" means not yet
 * imported or removed - still something the queue is tracking.
 */

import { and, isNotNull, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadQueue } from '#lib/server/db/schema.js';

export async function buildQueueStatus(mediaType: 'movie' | 'tv') {
	const mediaFilter = isNotNull(
		mediaType === 'movie' ? downloadQueue.movieId : downloadQueue.seriesId
	);

	const rows = await db
		.select({ status: downloadQueue.status })
		.from(downloadQueue)
		.where(and(mediaFilter, sql`${downloadQueue.status} NOT IN ('imported', 'removed')`));

	const count = rows.length;
	const errors = rows.some((row) => row.status === 'failed');

	return {
		id: 1,
		totalCount: count,
		count,
		// No equivalent to Radarr/Sonarr's "unknown" queue items (releases the
		// client can't categorize) in Cinephage's model.
		unknownCount: 0,
		errors,
		// No equivalent to a distinct "warning" state - failed items are
		// surfaced via `errors` above, there's nothing to set this on.
		warnings: false,
		unknownErrors: false,
		unknownWarnings: false
	};
}

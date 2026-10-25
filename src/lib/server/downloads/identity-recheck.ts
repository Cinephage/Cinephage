import { and, eq, notInArray, or } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadHistory, downloadQueue } from '#lib/server/db/schema.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';

export interface ResolvedIdentityRecheck {
	blocked: boolean;
	reason?: string;
}

/**
 * Post-resolution identity recheck (acquisition-system redesign).
 *
 * The grab pipeline runs before the canonical torrent info hash is
 * resolvable for .torrent download URLs (only magnet links carry the hash
 * upfront). Handlers fetch the torrent metainfo during resolution — this
 * check runs at that point, BEFORE the release is submitted to the download
 * client, and re-verifies the now-known hash against:
 *
 *   1. active acquisition intents (including this one, via setIdentity's
 *      unique-active-identity enforcement — catches cross-target dupes)
 *   2. the download queue (any non-terminal row)
 *   3. imported download history
 *
 * On a hit the caller must cancel its intent and abort the grab.
 */
export async function recheckResolvedIdentity(
	intentId: string,
	infoHash: string
): Promise<ResolvedIdentityRecheck> {
	// 1. Record the identity on the intent; the partial unique index on
	//    active identities rejects a duplicate cross-target acquisition.
	const identityResult = acquisitionService.setIdentity(intentId, {
		kind: 'info_hash',
		value: infoHash
	});
	if (!identityResult.ok) {
		const conflict = identityResult.conflict;
		return {
			blocked: true,
			reason: `Duplicate release: "${conflict.releaseTitle}" is already being acquired (since ${conflict.createdAt})`
		};
	}

	// 2. Queue rows (covers pre-migration rows without intents). Any
	//    non-terminal row with this hash is an active duplicate — including
	//    completed-but-unimported and stalled downloads.
	const existingQueue = await db
		.select({ id: downloadQueue.id })
		.from(downloadQueue)
		.where(
			and(
				or(eq(downloadQueue.infoHash, infoHash), eq(downloadQueue.downloadId, infoHash)),
				notInArray(downloadQueue.status, ['removed', 'failed', 'imported', 'seeding-imported'])
			)
		)
		.limit(1);

	if (existingQueue.length > 0) {
		return {
			blocked: true,
			reason: `Duplicate hash already importing: ${infoHash}`
		};
	}

	// 3. Imported history (the release was already imported for some target).
	const imported = await db
		.select({ id: downloadHistory.id })
		.from(downloadHistory)
		.where(
			and(
				or(eq(downloadHistory.infoHash, infoHash), eq(downloadHistory.downloadId, infoHash)),
				eq(downloadHistory.status, 'imported')
			)
		)
		.limit(1);

	if (imported.length > 0) {
		return {
			blocked: true,
			reason: `Duplicate hash was already imported: ${infoHash}`
		};
	}

	return { blocked: false };
}

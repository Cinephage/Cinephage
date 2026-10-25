import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { db } from '#lib/server/db/index.js';
import { downloadHistory, downloadQueue } from '#lib/server/db/schema.js';
import { and, eq, notInArray, or } from 'drizzle-orm';
import { resolveInfoHash } from '#lib/server/downloadClients/utils/hashUtils.js';
import { POST_IMPORT_QUEUE_STATUSES, TERMINAL_QUEUE_STATUSES } from '#lib/types/queue.js';

/**
 * Queue statuses that must NOT block a re-grab: failed attempts are retryable
 * (addToQueue deliberately excludes them so they can be resurrected), removed
 * rows are gone, and post-import rows are already covered by the imported
 * history check above.
 */
const NON_BLOCKING_QUEUE_STATUSES: string[] = [
	'failed',
	...TERMINAL_QUEUE_STATUSES,
	...POST_IMPORT_QUEUE_STATUSES
];

function getReleaseInfoHash(ctx: GrabDecisionContext): string | undefined {
	return resolveInfoHash(ctx.release.infoHash, ctx.release.magnetUrl, ctx.release.downloadUrl);
}

export class DuplicateHashStage implements DecisionStage<GrabDecisionContext> {
	name = 'duplicateHash';

	isEnabled(ctx: GrabDecisionContext): boolean {
		return ctx.options.overrideHardStages !== true && !!getReleaseInfoHash(ctx);
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const infoHash = getReleaseInfoHash(ctx);
		if (!infoHash) return { accepted: true };

		// Queue rows are routinely removed after import, so imported history must
		// also participate in hash deduplication regardless of the current target.
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
				accepted: false,
				reason: `Duplicate hash was already imported: ${infoHash}`,
				details: { rejectionType: 'duplicate_hash', infoHash }
			};
		}

		const existing = await db
			.select({ id: downloadQueue.id })
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.infoHash, infoHash),
					notInArray(downloadQueue.status, NON_BLOCKING_QUEUE_STATUSES)
				)
			)
			.limit(1);

		if (existing.length > 0) {
			return {
				accepted: false,
				reason: `Duplicate hash already in download queue: ${infoHash}`,
				details: { rejectionType: 'duplicate_hash', infoHash }
			};
		}

		return { accepted: true };
	}
}

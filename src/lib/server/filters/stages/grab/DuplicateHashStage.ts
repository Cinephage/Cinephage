import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext, GrabTarget } from './types.js';
import { db } from '#lib/server/db/index.js';
import { downloadQueue } from '#lib/server/db/schema.js';
import { and, eq, notInArray } from 'drizzle-orm';
import { resolveInfoHash } from '#lib/server/downloadClients/utils/hashUtils.js';
import { resolveImportedScope } from '#lib/server/downloads/imported-scope.js';
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

/** The episode scope this grab asks for, in the terms imported history records. */
function requestedScope(target: GrabTarget): {
	movieId?: string;
	seriesId?: string;
	episodeIds?: string[];
} {
	switch (target.type) {
		case 'movie':
			return { movieId: target.movieId };
		case 'episode':
			return { seriesId: target.seriesId, episodeIds: [target.episodeId] };
		case 'season':
		case 'series':
			return { seriesId: target.seriesId, episodeIds: target.episodeIds };
	}
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
		// It only blocks for the episodes it actually delivered, though: a pack
		// imported for episodes 1-6 is not a duplicate of a grab for episode 7,
		// and treating it as one leaves the rest of the season unreachable (#663).
		const importedScope = await resolveImportedScope({ infoHash, ...requestedScope(ctx.target) });

		if (importedScope.satisfied) {
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

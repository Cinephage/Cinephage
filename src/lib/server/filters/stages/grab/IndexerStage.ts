import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';

/**
 * Enforces the scoring profile's indexer allowlist at grab time.
 *
 * Search already skips excluded indexers, so this only fires for releases that
 * arrived some other way — an interactive result from a previous profile state,
 * a stale search cache, or an arr-pushed release. It mirrors ProtocolStage:
 * policy-level, and bypassed by a plain force grab.
 */
export class IndexerStage implements DecisionStage<GrabDecisionContext> {
	name = 'indexer';

	isEnabled(ctx: GrabDecisionContext): boolean {
		return !ctx.options.force;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const { release, profile } = ctx;
		const allowed = profile?.allowedIndexerIds;

		// null/undefined/empty means the profile is unrestricted.
		if (!allowed || allowed.length === 0) {
			return { accepted: true };
		}

		// A release with no indexer ID cannot be attributed; identity and
		// duplicate-hash stages still protect it, so let it through.
		if (!release.indexerId) {
			return { accepted: true };
		}

		if (allowed.includes(release.indexerId)) {
			return { accepted: true };
		}

		return {
			accepted: false,
			reason: `Release comes from indexer '${release.indexerName ?? release.indexerId}', which is not selected in quality profile '${profile.name}'`,
			details: { rejectionType: 'indexer_not_allowed', allowedIndexerIds: allowed }
		};
	}
}

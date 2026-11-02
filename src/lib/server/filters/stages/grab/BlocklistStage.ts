import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { blocklistService } from '#lib/server/blocklist/BlocklistService.js';

export class BlocklistStage implements DecisionStage<GrabDecisionContext> {
	name = 'blocklist';

	isEnabled(ctx: GrabDecisionContext): boolean {
		return ctx.options.overrideHardStages !== true && !ctx.options.skipBlocklist;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const { release, target } = ctx;

		const movieId = target.type === 'movie' ? target.movieId : undefined;
		const seriesId =
			target.type === 'episode' || target.type === 'season' || target.type === 'series'
				? target.seriesId
				: undefined;

		const result = await blocklistService.isBlocklisted(release, { movieId, seriesId });

		if (result.blocked) {
			return {
				accepted: false,
				reason: result.reason ?? 'Release is blocklisted',
				details: { rejectionType: 'blocklisted' }
			};
		}

		return { accepted: true };
	}
}

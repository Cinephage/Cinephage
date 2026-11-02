import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { qualityFilter } from '#lib/server/quality/QualityFilter.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import type { SizeValidationContext } from '#lib/server/scoring/types.js';

const parser = new ReleaseParser();

export class ScoringStage implements DecisionStage<GrabDecisionContext> {
	name = 'scoring';

	isEnabled(_ctx: GrabDecisionContext): boolean {
		return true;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const { release, target, profile } = ctx;

		const parsed = parser.parse(release.title);

		const sizeContext: SizeValidationContext | undefined =
			target.type === 'movie'
				? { mediaType: 'movie' }
				: target.type === 'episode'
					? { mediaType: 'tv' }
					: target.type === 'season'
						? { mediaType: 'tv', isSeasonPack: true, episodeCount: target.episodeIds.length }
						: { mediaType: 'tv' };

		const result = qualityFilter.calculateEnhancedScore(
			parsed,
			profile,
			release.size,
			sizeContext,
			release.indexerName,
			release.protocol
		);

		ctx.computed.scoringResult = result.scoringResult;
		ctx.computed.candidateScore = result.scoringResult.totalScore;
		ctx.computed.isBanned = result.scoringResult.isBanned;
		ctx.computed.bannedReasons = result.scoringResult.bannedReasons;
		ctx.computed.sizeRejected = result.scoringResult.sizeRejected;
		ctx.computed.sizeRejectionReason = result.scoringResult.sizeRejectionReason;
		ctx.computed.protocolRejected = result.scoringResult.protocolRejected;
		ctx.computed.protocolRejectionReason = result.scoringResult.protocolRejectionReason;
		ctx.computed.meetsMinimum = result.scoringResult.meetsMinimum;

		return { accepted: true };
	}
}

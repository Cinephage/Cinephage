import { composeDecisionStages } from './compositor.js';
import type { DecisionAudit, StageResult } from './types.js';
import type {
	GrabDecisionContext,
	GrabDecision,
	RejectionType,
	UpgradeStats
} from './stages/grab/types.js';
import { BlocklistStage } from './stages/grab/BlocklistStage.js';
import { IdentityStage } from './stages/grab/IdentityStage.js';
import { ScoringStage } from './stages/grab/ScoringStage.js';
import { BannedFormatStage } from './stages/grab/BannedFormatStage.js';
import { SizeValidationStage } from './stages/grab/SizeValidationStage.js';
import { ProtocolStage } from './stages/grab/ProtocolStage.js';
import { IndexerStage } from './stages/grab/IndexerStage.js';
import { MinimumScoreStage } from './stages/grab/MinimumScoreStage.js';
import { DuplicateHashStage } from './stages/grab/DuplicateHashStage.js';
import { MediaOccupancyStage } from './stages/grab/MediaOccupancyStage.js';
import { BlockedExtensionStage } from './stages/grab/BlockedExtensionStage.js';
import { UpgradeStage } from './stages/grab/UpgradeStage.js';
import { DelayStage } from './stages/grab/DelayStage.js';
import { LanguageStage } from './stages/grab/LanguageStage.js';
import { RequiredFormatsStage } from './stages/grab/RequiredFormatsStage.js';

export class GrabDecisionPipeline {
	private stages = [
		new IdentityStage(),
		new BlocklistStage(),
		new ScoringStage(),
		new BannedFormatStage(),
		new RequiredFormatsStage(),
		new LanguageStage(),
		new SizeValidationStage(),
		new ProtocolStage(),
		new IndexerStage(),
		new MinimumScoreStage(),
		new DuplicateHashStage(),
		new MediaOccupancyStage(),
		new BlockedExtensionStage(),
		new UpgradeStage(),
		new DelayStage()
	];

	async evaluate(ctx: GrabDecisionContext, options?: { runAll?: boolean }): Promise<GrabDecision> {
		const audit = await composeDecisionStages(this.stages, ctx, options);
		const upgradeStageResult = audit.stages.find((s) => s.name === 'upgrade');
		const upgradeStats = upgradeStageResult?.result?.details?.upgradeStats as
			UpgradeStats | undefined;

		const rejectionType = !audit.finalResult.accepted ? this.mapRejectionType(audit) : undefined;

		const existingScore = ctx.computed.existingScore;
		const candidateScoreRaw = ctx.computed.candidateScore ?? 0;
		const candidateScore = Number.isFinite(candidateScoreRaw) ? candidateScoreRaw : 0;

		return {
			accepted: audit.finalResult.accepted,
			reason: audit.finalResult.reason ?? (audit.finalResult.accepted ? 'Accepted' : 'Rejected'),
			rejectionType,
			upgradeStatus:
				ctx.computed.upgradeStatus ?? (ctx.existingFiles.length === 0 ? 'new' : 'rejected'),
			scores: {
				candidate: candidateScore,
				existing:
					existingScore !== undefined && Number.isFinite(existingScore) ? existingScore : undefined,
				improvement:
					existingScore !== undefined && Number.isFinite(existingScore)
						? candidateScore - existingScore
						: undefined
			},
			upgradeStats,
			audit
		};
	}

	/**
	 * Hard identity check only. Force-override/manual grabs skip policy but
	 * must still verify the release actually refers to the target media.
	 */
	async evaluateIdentity(ctx: GrabDecisionContext): Promise<StageResult> {
		const stage = this.stages.find((candidate) => candidate.name === 'identity') as
			IdentityStage | undefined;
		if (!stage || !stage.isEnabled(ctx)) {
			return { accepted: true };
		}
		return stage.evaluate(ctx);
	}

	private mapRejectionType(audit: DecisionAudit): RejectionType | undefined {
		const rejectingStage = audit.stages.find((s) => !s.skipped && s.result && !s.result.accepted);
		if (!rejectingStage) return undefined;

		const map: Record<string, RejectionType> = {
			identity: 'identity_mismatch',
			blocklist: 'blocklisted',
			bannedFormat: 'banned',
			requiredFormats: 'missing_required_format',
			sizeValidation: 'size_rejected',
			protocol: 'protocol_rejected',
			indexer: 'indexer_not_allowed',
			minimumScore: 'below_minimum',
			duplicateHash: 'duplicate_hash',
			mediaOccupancy: 'media_occupied',
			blockedExtension: 'blocked_extension',
			upgrade: 'not_upgrade',
			delay: 'pending_delay'
		};

		return map[rejectingStage.name];
	}
}

export const grabDecisionPipeline = new GrabDecisionPipeline();

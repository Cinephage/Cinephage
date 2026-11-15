import { mediaOccupancyService } from '#lib/server/acquisition/MediaOccupancyService.js';
import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { createChildLogger } from '#lib/logging/index.js';
import { skipsHardStages } from './hard-stage-policy.js';

const logger = createChildLogger({ module: 'MediaOccupancyStage' });

export class MediaOccupancyStage implements DecisionStage<GrabDecisionContext> {
	name = 'mediaOccupancy';

	// Pre-flight advisory check for a readable rejection message. The
	// authoritative enforcement is the DB-level reservation in
	// AcquisitionService.createIntent, which still applies to a manual grab
	// (one active acquisition per slot). What this stage adds - and what a
	// manual grab must not be refused for - is the "already has a file" case:
	// a manual grab replaces the file instead of being turned away.
	isEnabled(ctx: GrabDecisionContext): boolean {
		return !skipsHardStages(ctx.options);
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const result = await mediaOccupancyService.check(ctx.target, {
			isUpgrade: ctx.options.isUpgrade,
			candidateResolution: ctx.computed.scoringResult?.resolution
		});

		if (!result.occupied) {
			return { accepted: true };
		}

		logger.debug(
			{
				reason: result.reason,
				target: ctx.target,
				details: result.details
			},
			'[MediaOccupancyStage] Target occupied'
		);

		return {
			accepted: false,
			reason: `Media target is already occupied: ${result.reason}`,
			details: {
				rejectionType: 'media_occupied',
				reason: result.reason,
				...result.details
			}
		};
	}
}

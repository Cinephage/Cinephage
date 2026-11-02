import { mediaOccupancyService } from '#lib/server/acquisition/MediaOccupancyService.js';
import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MediaOccupancyStage' });

export class MediaOccupancyStage implements DecisionStage<GrabDecisionContext> {
	name = 'mediaOccupancy';

	// Pre-flight advisory check for a readable rejection message. The
	// authoritative enforcement is the DB-level reservation in
	// AcquisitionService.createIntent, which applies to manual grabs too.
	// This stage runs for manual (non-automatic) grabs as well; only an
	// explicit force skips it — and force never bypasses the reservation.
	isEnabled(ctx: GrabDecisionContext): boolean {
		return ctx.options.overrideHardStages !== true;
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

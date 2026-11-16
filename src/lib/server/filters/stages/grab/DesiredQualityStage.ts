import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { effectiveBuckets } from '#lib/server/quality/buckets.js';

/**
 * Desired-resolution containment at grab approval.
 *
 * `movies.desired_qualities` is the user's explicit target list, chosen in the
 * add flow. The scoring profile only *ranks* resolutions against each other
 * (Balanced scores 2160p 250 vs 1080p 200) - it never caps them - so a
 * movie added at 1080p grabbed the 2160p release whenever one existed: the
 * +50 point gap is worth more than the whole audio-language bonus (+25 max).
 * That is the reported defect: "1080p as desired quality" produced a 4K grab.
 *
 * Ranking is not a constraint, so this stage makes the declared list one. It
 * reuses `effectiveBuckets` (the same clamp the multi-quality paths apply):
 *
 *  - no declared list, or a profile range that empties it → no constraint
 *  - candidate resolution unknown                        → accepted (absence
 *    of evidence is never a rejection - same rule as LanguageStage)
 *  - any declared tier (multi-quality lists included)    → accepted
 *  - a known resolution outside the list                 → rejected, and the
 *    automatic search falls through to the next candidate
 *
 * A forced/manual grab is the user's deliberate choice and bypasses it, like
 * the other policy stages.
 */
export class DesiredQualityStage implements DecisionStage<GrabDecisionContext> {
	name = 'desiredQuality';

	isEnabled(ctx: GrabDecisionContext): boolean {
		return ctx.target.type === 'movie' && !ctx.options.force;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const desired = effectiveBuckets(
			ctx.desiredQualities,
			ctx.profile.minResolution,
			ctx.profile.maxResolution
		);
		if (desired.length === 0) return { accepted: true };

		const resolution = ctx.computed.scoringResult?.resolution;
		if (!resolution || resolution === 'unknown') return { accepted: true };
		if (desired.includes(resolution)) return { accepted: true };

		return {
			accepted: false,
			reason: `Resolution ${resolution} is outside the movie's desired qualities [${desired.join(', ')}]`,
			details: { rejectionType: 'desired_quality', resolution, desiredQualities: desired }
		};
	}
}

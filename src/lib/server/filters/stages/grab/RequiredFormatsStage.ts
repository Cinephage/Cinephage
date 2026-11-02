import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { getFormat } from '#lib/server/scoring/formats/index.js';

export class RequiredFormatsStage implements DecisionStage<GrabDecisionContext> {
	name = 'requiredFormats';

	isEnabled(ctx: GrabDecisionContext): boolean {
		return !ctx.options.force && (ctx.profile.requiredFormats?.length ?? 0) > 0;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const required = ctx.profile.requiredFormats ?? [];
		if (required.length === 0) return { accepted: true };

		const matched = new Set(
			(ctx.computed.scoringResult?.matchedFormats ?? []).map((f) => f.format.id)
		);

		const andEntries = required.filter((e) => e.op === 'AND');
		const orEntries = required.filter((e) => e.op === 'OR');

		const missingAnd = andEntries.filter((e) => !matched.has(e.id));
		const orSatisfied = orEntries.length === 0 || orEntries.some((e) => matched.has(e.id));

		const missing = [...missingAnd];
		if (!orSatisfied) {
			// None of the OR formats matched — report all of them as missing
			missing.push(...orEntries);
		}

		if (missing.length > 0) {
			const names = missing.map((e) => getFormat(e.id)?.name ?? e.id).join(', ');
			const orLabel = !orSatisfied
				? ` (needs at least one of: ${orEntries.map((e) => getFormat(e.id)?.name ?? e.id).join(', ')})`
				: '';
			return {
				accepted: false,
				reason: `Missing required format${missing.length > 1 ? 's' : ''}: ${names}${orLabel}`,
				details: {
					rejectionType: 'missing_required_format',
					missingFormats: missing.map((e) => e.id)
				}
			};
		}

		return { accepted: true };
	}
}

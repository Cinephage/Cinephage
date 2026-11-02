import { describe, expect, it } from 'vitest';
import { RequiredFormatsStage } from './RequiredFormatsStage.js';
import { makeGrabDecisionContext } from '../../../../../test/fixtures/filters.js';
import { createScoringProfile } from '../../../../../test/fixtures/releases.js';
import type { GrabDecisionContext } from './types.js';
import type { ScoringResult, ScoredFormat } from '#lib/server/scoring/types.js';

const stage = new RequiredFormatsStage();

/** Build a scoring result whose matched-format ids are exactly `ids`. */
function scoringResultWith(ids: string[]): ScoringResult {
	return {
		releaseName: 'Movie.2024.2160p.WEB-DL.DV.HDR10+.DDP5.1.H.265-GROUP',
		profile: 'Test',
		resolution: '2160p',
		totalScore: 0,
		breakdown: {} as ScoringResult['breakdown'],
		matchedFormats: ids.map(
			(id) =>
				({
					format: { id, name: id, category: 'hdr', tags: [], conditions: [] },
					conditionResults: [],
					score: 0
				}) as ScoredFormat
		),
		meetsMinimum: true,
		isBanned: false,
		bannedReasons: [],
		sizeRejected: false,
		protocolRejected: false
	};
}

function contextWith(
	ids: string[],
	required: { id: string; op: 'AND' | 'OR' }[]
): GrabDecisionContext {
	const ctx = makeGrabDecisionContext();
	return {
		...ctx,
		profile: createScoringProfile({ requiredFormats: required }) as GrabDecisionContext['profile'],
		computed: { scoringResult: scoringResultWith(ids) }
	};
}

describe('RequiredFormatsStage', () => {
	it('is disabled when the profile has no required formats', () => {
		expect(stage.isEnabled(contextWith(['hdr-dolby-vision'], []))).toBe(false);
	});

	it('is disabled by force', () => {
		const ctx: GrabDecisionContext = {
			...contextWith(['hdr-dolby-vision'], [{ id: 'hdr-hdr10plus', op: 'AND' }]),
			options: { ...makeGrabDecisionContext().options, force: true }
		};
		expect(stage.isEnabled(ctx)).toBe(false);
	});

	it('accepts a release whose detected set includes a lower-priority required format (#640)', async () => {
		// DV is the headline format; HDR10+ was also detected and must satisfy the rule.
		const result = await stage.evaluate(
			contextWith(['hdr-dolby-vision', 'hdr-hdr10plus'], [{ id: 'hdr-hdr10plus', op: 'AND' }])
		);

		expect(result.accepted).toBe(true);
	});

	it('rejects a release that genuinely lacks the required format', async () => {
		const result = await stage.evaluate(
			contextWith(['hdr-dolby-vision'], [{ id: 'hdr-hdr10plus', op: 'AND' }])
		);

		expect(result.accepted).toBe(false);
		expect(result.details?.rejectionType).toBe('missing_required_format');
		expect(result.details?.missingFormats).toEqual(['hdr-hdr10plus']);
	});

	it('satisfies an OR group from any detected format', async () => {
		const result = await stage.evaluate(
			contextWith(
				['hdr-dolby-vision', 'hdr-hdr10plus'],
				[
					{ id: 'hdr-hdr10plus', op: 'OR' },
					{ id: 'hdr-hlg', op: 'OR' }
				]
			)
		);

		expect(result.accepted).toBe(true);
	});

	it('requires every AND entry', async () => {
		const result = await stage.evaluate(
			contextWith(
				['hdr-dolby-vision', 'hdr-hdr10plus'],
				[
					{ id: 'hdr-hdr10plus', op: 'AND' },
					{ id: 'audio-atmos', op: 'AND' }
				]
			)
		);

		expect(result.accepted).toBe(false);
		expect(result.details?.missingFormats).toEqual(['audio-atmos']);
	});
});

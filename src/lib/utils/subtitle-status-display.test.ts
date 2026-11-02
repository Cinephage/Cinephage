import { describe, it, expect } from 'vitest';
import { deriveSeriesSubtitleProgress, deriveSubtitleProgress } from './subtitle-status-display.js';
import type { SubtitleStatusSummary } from './subtitle-status-display.js';
import type { LanguageProfileV2 } from '#lib/shared/language-profile.js';

const profile: Pick<LanguageProfileV2, 'subtitles' | 'cutoffRank'> = {
	subtitles: [
		{ tag: 'en', variant: 'regular', accessibility: 'any' },
		{ tag: 'de', variant: 'regular', accessibility: 'any' },
		{ tag: 'fr', variant: 'forced', accessibility: 'any' }
	],
	cutoffRank: null
};

function status(missingCount: number, satisfied = missingCount === 0): SubtitleStatusSummary {
	const missing = Array.from({ length: missingCount }, (_, i) => ({
		tag: profile.subtitles[i].tag,
		variant: profile.subtitles[i].variant,
		accessibility: profile.subtitles[i].accessibility
	}));
	return { satisfied, missing };
}

describe('deriveSubtitleProgress', () => {
	it('returns null without a status or profile', () => {
		expect(deriveSubtitleProgress(null, profile)).toBeNull();
		expect(deriveSubtitleProgress(status(0), null)).toBeNull();
		expect(deriveSubtitleProgress(undefined, profile)).toBeNull();
	});

	it('returns null for a profile without subtitle requirements', () => {
		expect(deriveSubtitleProgress(status(0), { subtitles: [], cutoffRank: null })).toBeNull();
	});

	it('counts every requirement when no cutoff is set', () => {
		const progress = deriveSubtitleProgress(status(0, true), profile);
		expect(progress).toEqual({
			satisfiedCount: 3,
			totalCount: 3,
			satisfiedViaCutoff: false,
			state: 'satisfied'
		});
	});

	it('derives partial progress from the missing list', () => {
		const progress = deriveSubtitleProgress(status(1, false), profile);
		expect(progress).toEqual({
			satisfiedCount: 2,
			totalCount: 3,
			satisfiedViaCutoff: false,
			state: 'partial'
		});
	});

	it('reports missing when nothing is satisfied', () => {
		const progress = deriveSubtitleProgress(status(3, false), profile);
		expect(progress).toMatchObject({ satisfiedCount: 0, totalCount: 3, state: 'missing' });
	});

	it('uses the cutoff window as the denominator and flags satisfied-via-cutoff', () => {
		// cutoff at rank 1: only requirements 0..1 are counted; requirement 1
		// satisfied, requirement 0 missing -> "1 of 2" + cutoff marker.
		const progress = deriveSubtitleProgress(
			{
				satisfied: true,
				missing: [{ tag: 'en', variant: 'regular', accessibility: 'any' }]
			},
			{ ...profile, cutoffRank: 1 }
		);
		expect(progress).toEqual({
			satisfiedCount: 1,
			totalCount: 2,
			satisfiedViaCutoff: true,
			state: 'partial'
		});
	});

	it('marks satisfied-via-cutoff even when the whole window is met', () => {
		const progress = deriveSubtitleProgress(status(0, true), { ...profile, cutoffRank: 1 });
		expect(progress).toMatchObject({
			satisfiedCount: 2,
			totalCount: 2,
			satisfiedViaCutoff: true,
			state: 'satisfied'
		});
	});

	it('clamps the cutoff rank to the requirement list length', () => {
		const progress = deriveSubtitleProgress(status(0, true), { ...profile, cutoffRank: 7 });
		expect(progress).toMatchObject({ satisfiedCount: 3, totalCount: 3, satisfiedViaCutoff: false });
	});
});

describe('deriveSeriesSubtitleProgress', () => {
	it('sums counts across episodes with counts', () => {
		const progress = deriveSeriesSubtitleProgress([
			{ subtitleCounts: { satisfiedCount: 1, totalRequirements: 2 } },
			{ subtitleCounts: { satisfiedCount: 2, totalRequirements: 2 } },
			{ subtitleCounts: null }
		]);
		expect(progress).toEqual({
			satisfiedCount: 3,
			totalCount: 4,
			satisfiedViaCutoff: false,
			state: 'partial'
		});
	});

	it('returns satisfied only when every counted requirement is met', () => {
		const progress = deriveSeriesSubtitleProgress([
			{ subtitleCounts: { satisfiedCount: 2, totalRequirements: 2 } },
			{ subtitleCounts: { satisfiedCount: 1, totalRequirements: 1 } }
		]);
		expect(progress?.state).toBe('satisfied');
	});

	it('returns null when no episode has counts', () => {
		expect(deriveSeriesSubtitleProgress([{ subtitleCounts: null }, {}])).toBeNull();
		expect(deriveSeriesSubtitleProgress([])).toBeNull();
	});

	it('ignores zero-requirement entries', () => {
		const progress = deriveSeriesSubtitleProgress([
			{ subtitleCounts: { satisfiedCount: 0, totalRequirements: 0 } },
			{ subtitleCounts: { satisfiedCount: 0, totalRequirements: 3 } }
		]);
		expect(progress).toEqual({
			satisfiedCount: 0,
			totalCount: 3,
			satisfiedViaCutoff: false,
			state: 'missing'
		});
	});
});

/**
 * Subtitle Acquisition - candidate selection
 *
 * Single implementation of "given search results and one requirement, which
 * result may we download?". Every acquisition path (import, missing task,
 * upgrades, single/batch auto-search) routes through here so candidate
 * filtering cannot drift:
 *
 * 1. the full requirement tuple (language + variant + accessibility) must match
 *    via the shared matcher - a regular subtitle never fills a forced
 *    requirement and vice versa;
 * 2. only then is the 0-100 `matchScore` compared against the threshold.
 *
 * Hash matches are NOT exempt: `matchesRequirement` takes no hash input by
 * design, so a hash-verified result must still satisfy the tuple.
 *
 * When nothing is accepted, `bestRejected` carries the highest-scoring rejected
 * candidate plus why it lost, so callers can report "N results, best score X
 * below threshold Y" instead of a misleading "no results".
 */

import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import { DEFAULT_MINIMUM_SCORE } from '#lib/shared/language-profile.js';
import { matchesRequirement, type SubtitleLike } from './requirement-matcher.js';

/** Minimal search-result shape needed for candidate selection. */
export interface SearchResultLike extends SubtitleLike {
	language: string;
	matchScore: number;
}

/** Why the best candidate was rejected. */
export type CandidateRejectionReason = 'requirement' | 'threshold';

export interface CandidateSelection<T extends SearchResultLike> {
	/** Highest-scoring candidate that satisfies the tuple and the threshold. */
	best?: T;
	/**
	 * Highest-scoring result that was rejected, present only when `best` is
	 * absent and at least one result was rejected. `reason` is 'requirement'
	 * when that result failed the requirement tuple, 'threshold' when it matched
	 * the tuple but scored below `minScore`.
	 */
	bestRejected?: { result: T; reason: CandidateRejectionReason };
}

/**
 * Accepted candidates for a requirement, sorted by match score descending.
 * A result is accepted when the matcher passes AND `matchScore >= minScore`.
 */
export function selectCandidates<T extends SearchResultLike>(
	results: readonly T[],
	requirement: SubtitleRequirement,
	minScore: number = DEFAULT_MINIMUM_SCORE
): T[] {
	return results
		.filter(
			(result) =>
				matchesRequirement(
					{
						language: result.language,
						isForced: result.isForced,
						isHearingImpaired: result.isHearingImpaired
					},
					requirement
				) && result.matchScore >= minScore
		)
		.sort((a, b) => b.matchScore - a.matchScore);
}

/**
 * Pick the best downloadable candidate for a single requirement.
 *
 * @param results - Provider search results (any language/variant).
 * @param requirement - The requirement tuple the candidate must satisfy.
 * @param minScore - Minimum match score on the normalized 0-100 scale.
 * @returns `best` when a candidate is acceptable, otherwise (optionally)
 *          `bestRejected` describing the strongest rejected result.
 */
export function selectBestCandidate<T extends SearchResultLike>(
	results: readonly T[],
	requirement: SubtitleRequirement,
	minScore: number = DEFAULT_MINIMUM_SCORE
): CandidateSelection<T> {
	let best: T | undefined;
	let bestRejected: { result: T; reason: CandidateRejectionReason } | undefined;

	for (const result of results) {
		const tupleMatches = matchesRequirement(
			{
				language: result.language,
				isForced: result.isForced,
				isHearingImpaired: result.isHearingImpaired
			},
			requirement
		);

		if (tupleMatches && result.matchScore >= minScore) {
			if (!best || result.matchScore > best.matchScore) {
				best = result;
			}
			continue;
		}

		const reason: CandidateRejectionReason = tupleMatches ? 'threshold' : 'requirement';
		if (!bestRejected || result.matchScore > bestRejected.result.matchScore) {
			bestRejected = { result, reason };
		}
	}

	// When an acceptable candidate exists the rejection detail is irrelevant.
	return best ? { best } : bestRejected ? { bestRejected } : {};
}

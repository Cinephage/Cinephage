/**
 * Requirement-aware subtitle status display.
 *
 * Turns the server-computed `SubtitleStatus` (see
 * `#lib/server/subtitles/types.js`) plus the effective language profile into a
 * small view-model for the library badges ("2 of 3", "Cutoff met").
 *
 * Lives outside `#lib/server` so client components can import it; the status
 * shape below is a structural subset of the server type (loader-serialized).
 */

import type { LanguageProfileV2 } from '#lib/shared/language-profile.js';

/** Client-safe subset of the server's SubtitleStatus. */
export interface SubtitleStatusSummary {
	satisfied: boolean;
	/**
	 * Unsatisfied requirements. Mirrors the server's cutoff rule: truncated to
	 * the requirements counted (cutoffRank window), so every counted
	 * requirement is either satisfied or listed here.
	 */
	missing: Array<{ tag: string; variant: string; accessibility: string }>;
}

/** How many of the counted requirements are met, plus the display state. */
export interface SubtitleRequirementProgress {
	/** Requirements satisfied within the counted window. */
	satisfiedCount: number;
	/**
	 * Requirements counted — cutoff-aware denominator: cutoffRank + 1 when the
	 * profile sets a cutoff, otherwise every requirement. Matches the TV
	 * loader's `totalRequirements` semantics.
	 */
	totalCount: number;
	/**
	 * True when the profile's cutoff rank marked the item satisfied before
	 * every requirement was met (the counted window is smaller than the full
	 * requirement list). Drives the "Cutoff met" marker.
	 */
	satisfiedViaCutoff: boolean;
	/** 'missing' (0 met), 'partial' (some), 'satisfied' (all counted met). */
	state: 'missing' | 'partial' | 'satisfied';
}

/**
 * Derive the requirement progress view-model.
 *
 * Returns null when there is nothing requirement-aware to show (no status, no
 * profile, or a profile without subtitle requirements) — callers then fall
 * back to the language-agnostic badge behavior.
 *
 * @param status - The loader's subtitleStatus for the item
 * @param profile - The effective profile governing the item (subtitles + cutoffRank only)
 */
export function deriveSubtitleProgress(
	status: SubtitleStatusSummary | null | undefined,
	profile: Pick<LanguageProfileV2, 'subtitles' | 'cutoffRank'> | null | undefined
): SubtitleRequirementProgress | null {
	if (!status || !profile) return null;
	const requirements = profile.subtitles ?? [];
	if (requirements.length === 0) return null;

	const cutoffRank = profile.cutoffRank ?? null;
	const totalCount =
		cutoffRank !== null ? Math.min(cutoffRank + 1, requirements.length) : requirements.length;
	// The server truncates `missing` to the cutoff window (calculateStatus),
	// so every counted requirement is either satisfied or listed missing.
	const satisfiedCount = Math.max(0, totalCount - status.missing.length);
	const satisfiedViaCutoff = status.satisfied && totalCount < requirements.length;
	const state =
		satisfiedCount === 0 ? 'missing' : satisfiedCount < totalCount ? 'partial' : 'satisfied';

	return { satisfiedCount, totalCount, satisfiedViaCutoff, state };
}

/**
 * Aggregate requirement progress across a series' episodes (file-bearing
 * episodes with counts only — absent counts mean no effective requirements
 * for that episode and are excluded). Returns null when NO episode has
 * counts, so the badge hides exactly like the per-episode one. A series-level
 * cutoff marker is meaningless (episodes resolve independently), so
 * `satisfiedViaCutoff` is always false.
 */
export function deriveSeriesSubtitleProgress(
	episodes: Array<{
		subtitleCounts?: { satisfiedCount: number; totalRequirements: number } | null;
	}>
): SubtitleRequirementProgress | null {
	let satisfiedCount = 0;
	let totalCount = 0;
	let counted = false;

	for (const episode of episodes) {
		const counts = episode.subtitleCounts;
		if (!counts || counts.totalRequirements <= 0) continue;
		counted = true;
		satisfiedCount += counts.satisfiedCount;
		totalCount += counts.totalRequirements;
	}

	if (!counted || totalCount === 0) return null;

	const state =
		satisfiedCount === 0 ? 'missing' : satisfiedCount < totalCount ? 'partial' : 'satisfied';

	return { satisfiedCount, totalCount, satisfiedViaCutoff: false, state };
}

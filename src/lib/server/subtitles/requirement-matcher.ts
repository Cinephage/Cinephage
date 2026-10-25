/**
 * Subtitle Requirement Matcher
 *
 * The single implementation of "does this subtitle satisfy this requirement".
 * Pure module: no DB, no IO. Every consumer (status calculation, auto-search,
 * missing/upgrade tasks, adaptive backoff) routes through here so a requirement
 * tuple is interpreted identically everywhere.
 *
 * Requirement semantics (spec §4.1):
 * - Language: a base-only requirement tag (`en`, `zh`) accepts any region or
 *   script of the same base (`en-US`, `en-GB`, `zh-Hans`). A requirement with a
 *   region/script (`pt-BR`, `zh-Hant`, `es-419`) accepts ONLY the same canonical
 *   tag — a bare `pt` does not satisfy `pt-BR`, and `zh-Hans` never satisfies
 *   `zh-Hant`. Unresolvable input (including `und`) never satisfies anything.
 * - Variant: `regular` accepts non-forced only; `forced` accepts forced only;
 *   `both` accepts either.
 * - Accessibility: `any` and `prefer-hi` accept anything (`prefer-hi` is a
 *   ranking preference, not a filter); `require-hi` requires HI; `exclude-hi`
 *   rejects HI.
 *
 * NOTE: the matcher takes no hash input by design. A hash-verified search
 * result is not exempt from the requirement tuple — callers must not bypass
 * this function for hash matches.
 */

import { canonicalizeLanguageTag } from '#lib/shared/languages.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

/** Minimal subtitle shape needed to evaluate a requirement. */
export interface SubtitleLike {
	language: string;
	isForced?: boolean | null;
	isHearingImpaired?: boolean | null;
}

/**
 * Shared language rule for a subtitle language against a requirement tag.
 *
 * Exported for reuse by provider capability checks (`BaseProvider.canSearch`)
 * so provider-supported languages follow the same base/region rules.
 */
export function languageSatisfies(subtitleLanguage: string, requirementTag: string): boolean {
	const subtitle = canonicalizeLanguageTag(subtitleLanguage);
	const requirement = canonicalizeLanguageTag(requirementTag);
	// `und` and any unresolvable input canonicalize to '' and satisfy nothing.
	if (!subtitle || !requirement) return false;

	// Base-only requirement: same base with any region/script is acceptable.
	if (!requirement.includes('-')) {
		return subtitle.split('-')[0] === requirement;
	}

	// Region/script requirement: exact canonical tag only. Region aliases are
	// folded in by canonicalization (`zh-CN` -> `zh-Hans`), but a bare base can
	// never satisfy a regional/script requirement.
	return subtitle === requirement;
}

function variantSatisfies(isForced: boolean, variant: SubtitleRequirement['variant']): boolean {
	switch (variant) {
		case 'regular':
			return !isForced;
		case 'forced':
			return isForced;
		case 'both':
			return true;
	}
}

function accessibilitySatisfies(
	isHearingImpaired: boolean,
	accessibility: SubtitleRequirement['accessibility']
): boolean {
	switch (accessibility) {
		case 'any':
		case 'prefer-hi':
			return true;
		case 'require-hi':
			return isHearingImpaired;
		case 'exclude-hi':
			return !isHearingImpaired;
	}
}

/**
 * True when a subtitle satisfies the full requirement tuple.
 * Null/undefined flags are treated as false (non-forced, non-HI).
 */
export function matchesRequirement(
	subtitle: SubtitleLike,
	requirement: SubtitleRequirement
): boolean {
	const isForced = subtitle.isForced === true;
	const isHearingImpaired = subtitle.isHearingImpaired === true;
	return (
		languageSatisfies(subtitle.language, requirement.tag) &&
		variantSatisfies(isForced, requirement.variant) &&
		accessibilitySatisfies(isHearingImpaired, requirement.accessibility)
	);
}

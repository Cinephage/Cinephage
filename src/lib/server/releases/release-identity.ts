/**
 * Canonical release→target identity matching.
 *
 * One implementation shared by the grab-time IdentityStage, the automatic
 * search filters, and arr release pushes. Never hand-compare release titles
 * to library titles anywhere else — substring containment in particular is
 * forbidden: "halloween" is contained in "detective conan the bride of
 * halloween" and caused wrong-target imports.
 *
 * Identity is established ONLY by:
 *   1. exact equality of the normalized title, or
 *   2. Levenshtein similarity ≥ threshold (default 0.7), or
 *   3. an explicit external-ID match (handled by callers that have indexer
 *      IDs; this module arbitrates titles only)
 * plus year agreement whenever both sides carry a year.
 *
 * Token containment is deliberately NOT identity evidence ("Blade" vs
 * "Blade Runner", "Halloween" vs "The Bride of Halloween"). The restricted
 * containment helper below exists only so interactive search can keep
 * displaying plausible-but-unconfirmed releases; it must never gate
 * acquisition.
 */

import { calculateTitleSimilarity } from '#lib/server/library/title-matching.js';

const LEADING_ARTICLES = new Set(['the', 'a', 'an']);

/**
 * Split a title into comparison tokens: lowercase, diacritics folded,
 * non-alphanumerics as separators, leading articles dropped.
 */
export function titleTokens(input: string): string[] {
	const normalized = (input ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.normalize('NFKC')
		.toLowerCase();
	const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
	while (tokens.length > 0 && LEADING_ARTICLES.has(tokens[0])) {
		tokens.shift();
	}
	return tokens;
}

/** Normalize a title to its de-punctuated comparison form ("The Foo-Bar" → "foobar"). */
export function normalizeIdentityTitle(input: string): string {
	return titleTokens(input).join('');
}

export type IdentityYearMode =
	| 'strict'
	/** Season packs carry the season's air year, which can be later than the series' first-air year. */
	| 'forward-drift'
	/** Skip year arbitration entirely (caller has no usable year). */
	| 'none';

export interface ReleaseIdentityInput {
	/** Parsed release title (scene name cleaned of quality/group tokens). */
	releaseTitle: string;
	/** Year parsed from the release name, if any. */
	releaseYear?: number;
	/** Target title candidates: canonical title, original title, alternates. */
	targetTitles: string[];
	/** Movie release year or series first-air year. */
	targetYear?: number;
	yearMode?: IdentityYearMode;
	/** Levenshtein similarity threshold (default 0.7). */
	minimumSimilarity?: number;
}

export interface ReleaseIdentityMatch {
	matched: boolean;
	/** How the best candidate matched, when matched. */
	method: 'exact' | 'similarity' | 'none';
	bestSimilarity: number;
	/** Machine-readable failure reason, when not matched. */
	reason?: 'title_mismatch' | 'year_mismatch' | 'no_candidates';
	/** The candidate that produced the best score. */
	bestCandidate?: string;
}

function yearsAgree(
	releaseYear: number | undefined,
	targetYear: number | undefined,
	mode: IdentityYearMode
): boolean {
	if (mode === 'none') return true;
	if (!releaseYear || !targetYear) return true; // missing evidence is not a mismatch; caller policy decides
	if (mode === 'forward-drift') return releaseYear >= targetYear - 1;
	return Math.abs(releaseYear - targetYear) <= 1;
}

/**
 * Decide whether a release title refers to the target media.
 *
 * Year arbitration runs only when both sides carry a year. When the release
 * carries no year the title decides alone — callers enforcing stricter
 * evidence rules (e.g. automatic movie grabs) must treat a missing year as
 * insufficient separately.
 */
export function matchReleaseToTarget(input: ReleaseIdentityInput): ReleaseIdentityMatch {
	const candidates = input.targetTitles
		.map((title) => title.trim())
		.filter((title) => title.length > 0);
	if (candidates.length === 0) {
		return { matched: false, method: 'none', bestSimilarity: 0, reason: 'no_candidates' };
	}

	// Dual-language releases often join the primary and alternate titles with
	// " / " ("Оригинал / Original Title"). The library's target title is
	// usually single-language, so comparing the whole joined string drags
	// similarity down with tokens that were never meant to match; comparing
	// each segment too lets a clean match on either side decide identity
	// without weakening the full-string comparison (still tried first).
	const releaseCandidates = Array.from(
		new Set(
			[input.releaseTitle, ...input.releaseTitle.split(/\s*\/\s*/)]
				.map((segment) => segment.trim())
				.filter((segment) => segment.length > 0)
		)
	);

	let best: ReleaseIdentityMatch = {
		matched: false,
		method: 'none',
		bestSimilarity: 0,
		reason: 'title_mismatch'
	};

	for (const candidate of candidates) {
		const candidateNorm = normalizeIdentityTitle(candidate);
		if (candidateNorm.length === 0) continue;

		for (const releaseCandidate of releaseCandidates) {
			const releaseNorm = normalizeIdentityTitle(releaseCandidate);
			if (releaseNorm.length === 0) continue;

			let similarity: number;
			let method: 'exact' | 'similarity';
			if (releaseNorm === candidateNorm) {
				similarity = 1;
				method = 'exact';
			} else {
				similarity = calculateTitleSimilarity(releaseNorm, candidateNorm);
				method = 'similarity';
			}

			if (similarity > best.bestSimilarity) {
				best = {
					matched: false,
					method,
					bestSimilarity: similarity,
					bestCandidate: candidate,
					reason: 'title_mismatch'
				};
			}
			if (similarity >= (input.minimumSimilarity ?? 0.7)) {
				const yearMode = input.yearMode ?? 'strict';
				if (!yearsAgree(input.releaseYear, input.targetYear, yearMode)) {
					return {
						matched: false,
						method: 'none',
						bestSimilarity: similarity,
						reason: 'year_mismatch',
						bestCandidate: candidate
					};
				}
				return { matched: true, method, bestSimilarity: similarity, bestCandidate: candidate };
			}
		}
	}

	return best;
}

export interface TitleContainmentResult {
	/** True when the shorter token sequence appears contiguously inside the longer one. */
	contained: boolean;
	extraTokens: number;
}

/**
 * Restricted token containment — DISPLAY-ONLY (interactive search lists).
 * Requires the shorter side to span at least two tokens and allows at most
 * one extra token on the longer side, so "Show Name" still matches a release
 * titled "Show Name Special" in a result list, while "Halloween" can never
 * match "Detective Conan: The Bride of Halloween" (5 extra tokens) and
 * "Blade" can never match "Blade Runner" (single-token titles never contain).
 *
 * Never use this to approve an acquisition.
 */
export function matchTitleContainment(
	a: string,
	b: string,
	maxExtraTokens = 1
): TitleContainmentResult {
	const aTokens = titleTokens(a);
	const bTokens = titleTokens(b);
	const shorter = aTokens.length <= bTokens.length ? aTokens : bTokens;
	const longer = shorter === aTokens ? bTokens : aTokens;

	if (shorter.length < 2 || longer.length < shorter.length) {
		return { contained: false, extraTokens: 0 };
	}

	const extra = longer.length - shorter.length;
	if (extra === 0 || extra > maxExtraTokens) {
		return { contained: false, extraTokens: extra };
	}

	const maxStart = longer.length - shorter.length;
	for (let start = 0; start <= maxStart; start++) {
		let matches = true;
		for (let i = 0; i < shorter.length; i++) {
			if (longer[start + i] !== shorter[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return { contained: true, extraTokens: extra };
	}
	return { contained: false, extraTokens: extra };
}

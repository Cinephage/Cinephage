/**
 * Shared audio-preference policy core.
 *
 * The single implementation of ordered audio-language ranking. Consumers today:
 * playback stream-source selection (`streaming/language-utils.ts`, which
 * re-exports this module); per the 2026-09-15 audio-language acquisition
 * design, release search ranking, grab gating, and debrid file selection
 * consume the same four-bucket ordering so every decision path ranks
 * languages identically.
 */

import { normalizeLanguageCode, type LanguageTag } from '#lib/shared/languages.js';
import type { AudioAcquisitionMode } from '#lib/shared/language-profile.js';

export function languageMatches(candidateLang: string | undefined, prefCode: string): boolean {
	if (!candidateLang) return false;

	const normalizedCandidate = normalizeLanguageCode(candidateLang);
	const normalizedPref = normalizeLanguageCode(prefCode);

	if (normalizedCandidate === normalizedPref) return true;

	const candidateBase = normalizedCandidate.split('-')[0];
	const prefBase = normalizedPref.split('-')[0];

	return candidateBase === prefBase;
}

export function getLanguagePriority(
	candidateLang: string | undefined,
	preferredLanguages: string[]
): number {
	if (!preferredLanguages.length) return 0;

	for (let i = 0; i < preferredLanguages.length; i++) {
		if (languageMatches(candidateLang, preferredLanguages[i])) {
			return i;
		}
	}

	return Infinity;
}

/**
 * A fully resolved audio preference used for playback source selection and
 * snapshotted onto the playback session. Field order and values are canonical
 * (languages normalized + deduped) so snapshots can be compared reliably.
 * `mode` is the acquisition enforcement mode; playback itself is always soft.
 */
export interface EffectiveAudioPreference {
	/** Prefer sources whose audio matches the media's original language */
	preferOriginal: boolean;
	/** Ordered fallback audio languages (canonical tags); empty means no preference */
	languages: LanguageTag[];
	/** Canonical original language of the media, when known; null otherwise */
	originalLanguage: string | null;
	/** Acquisition enforcement mode ('prefer' ranks, 'require' may also reject) */
	mode: AudioAcquisitionMode;
}

/**
 * The preference used when nothing is known (no library entry, no profile, or
 * a failed lookup). Resolution of "no preference" MUST go through this
 * constant so session-reuse compatibility compares consistently: pre-deploy
 * sessions without a stored snapshot are only reusable while the current
 * request still resolves to exactly this value.
 */
export const DEFAULT_EFFECTIVE_AUDIO_PREFERENCE: EffectiveAudioPreference = {
	preferOriginal: true,
	languages: [],
	originalLanguage: null,
	mode: 'prefer'
};

/**
 * Deep equality for resolved audio preferences (the JSON-compare semantics
 * required for session reuse, written field-by-field so it does not depend on
 * key insertion order). Inputs are expected to be canonical (resolved through
 * the same code path). `mode` normalizes to 'prefer' so sessions stored
 * before the field existed stay reusable.
 */
export function audioPreferencesEqual(
	a: EffectiveAudioPreference,
	b: EffectiveAudioPreference
): boolean {
	if (a.preferOriginal !== b.preferOriginal) return false;
	if ((a.originalLanguage ?? null) !== (b.originalLanguage ?? null)) return false;
	if ((a.mode ?? 'prefer') !== (b.mode ?? 'prefer')) return false;
	if (a.languages.length !== b.languages.length) return false;
	return a.languages.every((tag, index) => tag === b.languages[index]);
}

/** Selection buckets for a candidate against a resolved audio preference. */
export const AUDIO_PREFERENCE_BUCKETS = {
	/** Matches the original language (when preferOriginal is on and it is known) */
	original: 0,
	/** Matches one of the profile's ordered fallback languages */
	preferred: 1,
	/** No language tag at all — treated as neutral */
	untagged: 2,
	/** Tagged, but matches neither the original nor any preferred language */
	other: 3
} as const;

/**
 * Rank a single candidate for the four-bucket audio ordering:
 * 0 = original-language match, 1 = preferred-language match (tie-broken by
 * preference index), 2 = untagged (neutral), 3 = everything else.
 *
 * Comparisons are normalized with base-tag fallback (see `languageMatches`):
 * an `eng`-tagged candidate matches an original language of `en`, and a `jpn`
 * candidate matches `ja`. `getLanguagePriority` returns 0 for an empty
 * preference list, so bucket 1 is skipped entirely when no fallback
 * languages are configured.
 */
function rankByAudioPreference<T extends { language?: string }>(
	candidate: T,
	preference: EffectiveAudioPreference
): { bucket: number; preferenceIndex: number } {
	if (
		preference.preferOriginal &&
		typeof preference.originalLanguage === 'string' &&
		preference.originalLanguage !== '' &&
		languageMatches(candidate.language, preference.originalLanguage)
	) {
		return { bucket: AUDIO_PREFERENCE_BUCKETS.original, preferenceIndex: 0 };
	}

	if (preference.languages.length > 0) {
		const preferenceIndex = getLanguagePriority(candidate.language, preference.languages);
		if (preferenceIndex !== Infinity) {
			return { bucket: AUDIO_PREFERENCE_BUCKETS.preferred, preferenceIndex };
		}
	}

	if (!candidate.language || candidate.language.trim() === '') {
		return { bucket: AUDIO_PREFERENCE_BUCKETS.untagged, preferenceIndex: 0 };
	}

	return { bucket: AUDIO_PREFERENCE_BUCKETS.other, preferenceIndex: 0 };
}

/**
 * Which audio bucket a candidate falls into for the given preference. Exported
 * so callers that already picked a candidate can record WHY it was picked
 * (e.g. the original language drove the choice of an untagged source).
 */
export function resolveAudioPreferenceBucket<T extends { language?: string }>(
	candidate: T,
	preference: EffectiveAudioPreference
): number {
	return rankByAudioPreference(candidate, preference).bucket;
}

/**
 * Rank a set of language-evidence tokens against a resolved audio preference.
 * Tokens are parsed title languages (including the parser's 'multi'/'orig'
 * pseudo-codes) optionally merged with structured indexer attrs.
 *
 * Same bucket semantics as the single-candidate ranking, extended for the
 * pseudo-codes: 'orig' counts as an original-language match, and 'multi'
 * ranks as a preferred candidate at the position just after the last
 * explicitly-matching language — a multi-audio pack probably contains a
 * preferred language, but titles are claims, not proof.
 */
export function rankLanguageEvidenceSet(
	languages: string[],
	preference: EffectiveAudioPreference
): { bucket: number; preferenceIndex: number } {
	const originalLanguage = preference.originalLanguage;
	if (
		preference.preferOriginal &&
		typeof originalLanguage === 'string' &&
		originalLanguage !== '' &&
		(languages.includes('orig') ||
			languages.some((tag) => tag !== 'multi' && languageMatches(tag, originalLanguage)))
	) {
		return { bucket: AUDIO_PREFERENCE_BUCKETS.original, preferenceIndex: 0 };
	}

	if (preference.languages.length > 0) {
		let best = Infinity;
		for (const tag of languages) {
			if (tag === 'multi' || tag === 'orig') continue;
			const index = getLanguagePriority(tag, preference.languages);
			if (index !== Infinity && index < best) best = index;
		}
		if (best !== Infinity) {
			return { bucket: AUDIO_PREFERENCE_BUCKETS.preferred, preferenceIndex: best };
		}
	}

	if (languages.includes('multi')) {
		// Candidate slot: after every explicit preference position.
		return {
			bucket: AUDIO_PREFERENCE_BUCKETS.preferred,
			preferenceIndex: preference.languages.length
		};
	}

	if (languages.length === 0) {
		return { bucket: AUDIO_PREFERENCE_BUCKETS.untagged, preferenceIndex: 0 };
	}

	return { bucket: AUDIO_PREFERENCE_BUCKETS.other, preferenceIndex: 0 };
}

/**
 * Order candidates by audio preference:
 * bucket 0: candidates matching `originalLanguage` (only when `preferOriginal`
 *           is on and an original language is known),
 * bucket 1: candidates matching `preference.languages`, in preference order
 *           (lower preference index first),
 * bucket 2: candidates without a language tag (neutral),
 * bucket 3: tagged candidates matching neither (e.g. unknown languages).
 *
 * Relies on `Array.prototype.sort` stability (guaranteed since ES2019):
 * candidates within a bucket keep their upstream order, so with the default
 * preference the upstream ordering is preserved unchanged. Returns a new
 * array; the input is not mutated.
 */
export function sortSourcesByAudioPreference<T extends { language?: string }>(
	sources: T[],
	preference: EffectiveAudioPreference
): T[] {
	return [...sources].sort((a, b) => {
		const rankA = rankByAudioPreference(a, preference);
		const rankB = rankByAudioPreference(b, preference);
		return rankA.bucket - rankB.bucket || rankA.preferenceIndex - rankB.preferenceIndex;
	});
}

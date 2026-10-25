/**
 * Pure audio-language gate logic shared by the arr-compat push path.
 * Mirrors the grab pipeline's LanguageStage truth table (see
 * `filters/stages/grab/LanguageStage.ts`); extracted so both surfaces can't
 * drift apart.
 */

import { extractLanguages } from '#lib/server/indexers/parser/patterns/language.js';
import {
	AUDIO_PREFERENCE_BUCKETS,
	rankLanguageEvidenceSet,
	type EffectiveAudioPreference
} from '#lib/server/languages/audio-preference.js';

/**
 * Returns rejection reasons when the title affirmatively contradicts a
 * require-mode preference, null otherwise (prefer mode, no expectation,
 * untagged title, multi pack, or a matching title all pass).
 */
export function evaluatePushLanguageGate(
	title: string,
	preference: EffectiveAudioPreference
): string[] | null {
	if (preference.mode !== 'require') return null;

	const hasOriginalSignal =
		preference.preferOriginal &&
		typeof preference.originalLanguage === 'string' &&
		preference.originalLanguage !== '';
	if (preference.languages.length === 0 && !hasOriginalSignal) return null;

	const evidence = extractLanguages(title).languages;
	if (evidence.length === 0) return null;

	const { bucket } = rankLanguageEvidenceSet(evidence, preference);
	if (bucket !== AUDIO_PREFERENCE_BUCKETS.other) return null;

	const wanted = [
		...(hasOriginalSignal ? [preference.originalLanguage] : []),
		...preference.languages
	];
	return [
		`Audio language requirement not met: release languages [${evidence.join(', ')}] do not include any of [${wanted.join(', ')}]`
	];
}

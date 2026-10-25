import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext, GrabTarget } from './types.js';
import { extractLanguages } from '#lib/server/indexers/parser/patterns/language.js';
import {
	AUDIO_PREFERENCE_BUCKETS,
	rankLanguageEvidenceSet
} from '#lib/server/languages/audio-preference.js';
import { resolveAudioPreferenceForItem } from '#lib/server/languages/audio-preference-resolver.js';

/**
 * Audio-language gate (audio-language acquisition design 2026-09-15, phase E).
 *
 * Enforces the effective profile's `audio.mode: 'require'` at grab approval.
 * Rejects ONLY on affirmative contradiction: the release title carries
 * explicit language tags and NONE of them matches the preference (bucket
 * 'other'). Untagged releases and multi-audio packs always pass — titles are
 * claims, not proof, and a pack's contents are unknowable pre-download (the
 * import verifier + shortfall loop catches those after the fact). 'prefer'
 * mode never rejects; ranking already expressed the preference.
 */
export class LanguageStage implements DecisionStage<GrabDecisionContext> {
	name = 'language';

	isEnabled(ctx: GrabDecisionContext): boolean {
		return !ctx.options.force;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const preference = await resolveTargetPreference(ctx.target);
		if (!preference || preference.mode !== 'require') {
			return { accepted: true };
		}
		const hasOriginalSignal =
			preference.preferOriginal &&
			typeof preference.originalLanguage === 'string' &&
			preference.originalLanguage !== '';
		if (preference.languages.length === 0 && !hasOriginalSignal) {
			// No expectation to contradict.
			return { accepted: true };
		}

		const evidence = extractLanguages(ctx.release.title).languages;
		if (evidence.length === 0) {
			// Absence of evidence is never a rejection.
			return { accepted: true };
		}

		const { bucket } = rankLanguageEvidenceSet(evidence, preference);
		if (bucket !== AUDIO_PREFERENCE_BUCKETS.other) {
			return { accepted: true };
		}

		return {
			accepted: false,
			reason: `Audio language requirement not met: title evidences [${evidence.join(', ')}], wanted [${[...(hasOriginalSignal ? [preference.originalLanguage] : []), ...preference.languages].join(', ')}]`,
			details: {
				rejectionType: 'language_requirement',
				evidence,
				mode: preference.mode
			}
		};
	}
}

/** Movies resolve their own chain; episodes/seasons/series resolve the series. */
async function resolveTargetPreference(target: GrabTarget) {
	if (target.type === 'movie') {
		return resolveAudioPreferenceForItem('movie', target.movieId);
	}
	return resolveAudioPreferenceForItem('series', target.seriesId);
}

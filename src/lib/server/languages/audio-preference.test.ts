import { describe, expect, it } from 'vitest';
import {
	AUDIO_PREFERENCE_BUCKETS,
	audioPreferencesEqual,
	rankLanguageEvidenceSet,
	type EffectiveAudioPreference
} from './audio-preference';

function preference(overrides: Partial<EffectiveAudioPreference> = {}): EffectiveAudioPreference {
	return {
		preferOriginal: false,
		languages: ['en', 'es'],
		originalLanguage: null,
		mode: 'prefer',
		...overrides
	};
}

describe('rankLanguageEvidenceSet', () => {
	it('ranks an original-language match (explicit tag) as bucket 0', () => {
		const rank = rankLanguageEvidenceSet(
			['en'],
			preference({
				preferOriginal: true,
				originalLanguage: 'en',
				languages: []
			})
		);
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.original);
	});

	it("treats the parser's 'orig' pseudo-code as an original match", () => {
		const rank = rankLanguageEvidenceSet(
			['orig', 'ru'],
			preference({
				preferOriginal: true,
				originalLanguage: 'en',
				languages: []
			})
		);
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.original);
	});

	it('ranks preferred languages by earliest index', () => {
		expect(rankLanguageEvidenceSet(['es'], preference()).bucket).toBe(
			AUDIO_PREFERENCE_BUCKETS.preferred
		);
		expect(rankLanguageEvidenceSet(['es'], preference()).preferenceIndex).toBe(1);
		expect(rankLanguageEvidenceSet(['en', 'es'], preference()).preferenceIndex).toBe(0);
	});

	it("ranks 'multi' as a preferred candidate after the last explicit preference", () => {
		const rank = rankLanguageEvidenceSet(['multi'], preference());
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.preferred);
		expect(rank.preferenceIndex).toBe(2);
	});

	it('prefers an explicit preferred match over a multi marker', () => {
		const rank = rankLanguageEvidenceSet(['multi', 'es'], preference());
		expect(rank.preferenceIndex).toBe(1);
	});

	it('ranks empty evidence as untagged/neutral', () => {
		expect(rankLanguageEvidenceSet([], preference()).bucket).toBe(
			AUDIO_PREFERENCE_BUCKETS.untagged
		);
	});

	it('ranks tagged-but-unmatched evidence as other', () => {
		expect(rankLanguageEvidenceSet(['it'], preference()).bucket).toBe(
			AUDIO_PREFERENCE_BUCKETS.other
		);
	});

	it('matches base tags (jpn source vs ja original)', () => {
		const rank = rankLanguageEvidenceSet(
			['jpn'],
			preference({
				preferOriginal: true,
				originalLanguage: 'ja',
				languages: []
			})
		);
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.original);
	});

	it('ignores the original language when preferOriginal is off', () => {
		const rank = rankLanguageEvidenceSet(
			['en'],
			preference({
				preferOriginal: false,
				originalLanguage: 'en',
				languages: ['fr']
			})
		);
		// 'en' is not in the fallback list → not preferred via original either
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.other);
	});

	it('does not let a non-listed original language outrank the list', () => {
		// Chinese original, profile "English then Spanish": the user asked for a
		// dub, so the untranslated original is not a preference signal.
		const rank = rankLanguageEvidenceSet(
			['zh'],
			preference({ preferOriginal: true, originalLanguage: 'zh', languages: ['en', 'es'] })
		);
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.other);
	});

	it('ranks a listed fallback language above a non-listed original', () => {
		const rank = rankLanguageEvidenceSet(
			['es'],
			preference({ preferOriginal: true, originalLanguage: 'zh', languages: ['en', 'es'] })
		);
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.preferred);
		expect(rank.preferenceIndex).toBe(1);
	});

	it('keeps the original bucket when the original language is listed', () => {
		const rank = rankLanguageEvidenceSet(
			['en'],
			preference({ preferOriginal: true, originalLanguage: 'en', languages: ['es', 'en'] })
		);
		expect(rank.bucket).toBe(AUDIO_PREFERENCE_BUCKETS.original);
	});
});

describe('audioPreferencesEqual mode normalization', () => {
	it('treats a missing mode as prefer (pre-mode snapshots stay reusable)', () => {
		const a: EffectiveAudioPreference = {
			preferOriginal: true,
			languages: [],
			originalLanguage: null,
			mode: 'prefer'
		};
		// Simulates a session snapshot stored before `mode` existed
		const legacy = {
			preferOriginal: true,
			languages: [],
			originalLanguage: null
		} as unknown as EffectiveAudioPreference;
		expect(audioPreferencesEqual(a, legacy)).toBe(true);
	});

	it('distinguishes prefer from require', () => {
		const a = preference();
		const b = preference({ mode: 'require' });
		expect(audioPreferencesEqual(a, b)).toBe(false);
	});
});

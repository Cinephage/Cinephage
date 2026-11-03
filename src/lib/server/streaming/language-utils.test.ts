import { describe, expect, it } from 'vitest';
import {
	AUDIO_PREFERENCE_BUCKETS,
	DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
	audioPreferencesEqual,
	resolveAudioPreferenceBucket,
	sortSourcesByAudioPreference,
	type EffectiveAudioPreference
} from './language-utils';

function source(language?: string) {
	return { id: language ?? 'untagged', language };
}

function preference(overrides: Partial<EffectiveAudioPreference> = {}): EffectiveAudioPreference {
	return { ...DEFAULT_EFFECTIVE_AUDIO_PREFERENCE, ...overrides };
}

describe('sortSourcesByAudioPreference', () => {
	it('returns the default preference constant untouched', () => {
		expect(DEFAULT_EFFECTIVE_AUDIO_PREFERENCE).toEqual({
			preferOriginal: true,
			languages: [],
			originalLanguage: null,
			mode: 'prefer'
		});
	});

	it('keeps the upstream order unchanged under the default preference', () => {
		const sources = [source('fr'), source(), source('de')];
		const sorted = sortSourcesByAudioPreference(sources, DEFAULT_EFFECTIVE_AUDIO_PREFERENCE);
		// Untagged sources are neutral (bucket 2) and rank above tagged ones that
		// match nothing (bucket 3); tagged sources keep their upstream order.
		expect(sorted.map((s) => s.id)).toEqual(['untagged', 'fr', 'de']);
	});

	it('puts original-language matches first, untagged before other tagged sources', () => {
		const pref = preference({ originalLanguage: 'ja' });
		const sorted = sortSourcesByAudioPreference(
			[
				source('de'),
				source('eng'), // 'eng' normalizes to 'en' - must NOT match 'ja'
				source('jpn'), // 'jpn' normalizes to 'ja' - original match
				source(),
				source('ko')
			],
			pref
		);
		expect(sorted.map((s) => s.id)).toEqual(['jpn', 'untagged', 'de', 'eng', 'ko']);
	});

	it('ranks profile fallback languages in preference order', () => {
		const pref = preference({ languages: ['pt-BR', 'fr'] });
		const sorted = sortSourcesByAudioPreference(
			[source('fr'), source('de'), source('pt-BR'), source()],
			pref
		);
		expect(sorted.map((s) => s.id)).toEqual(['pt-BR', 'fr', 'untagged', 'de']);
	});

	it('lets the original language win over profile fallback languages', () => {
		const pref = preference({ originalLanguage: 'en', languages: ['pt-BR', 'fr'] });
		// en-US matches the original by base tag; pt-BR (rank 0) outranks fr (rank 1).
		const sorted = sortSourcesByAudioPreference(
			[source('fr'), source('en-US'), source('pt-BR')],
			pref
		);
		expect(sorted.map((s) => s.id)).toEqual(['en-US', 'pt-BR', 'fr']);
	});

	it('ignores the original language when preferOriginal is off', () => {
		const pref = preference({ preferOriginal: false, originalLanguage: 'ja', languages: ['fr'] });
		const sorted = sortSourcesByAudioPreference([source('ja'), source('fr')], pref);
		expect(sorted.map((s) => s.id)).toEqual(['fr', 'ja']);
	});

	it('matches aliases and base tags through the shared normalizer', () => {
		const pref = preference({ languages: ['pt-BR'] });
		// 'pob' is a provider alias for pt-BR; 'pt' matches by base tag. Both hit
		// preference rank 0, so upstream order decides the tie (sort stability).
		const sorted = sortSourcesByAudioPreference([source('pt'), source('pob'), source('es')], pref);
		expect(sorted.map((s) => s.id)).toEqual(['pt', 'pob', 'es']);
	});

	it('is stable within buckets (ES2019 sort stability)', () => {
		const pref = preference({ originalLanguage: 'ja', languages: ['fr'] });
		const sorted = sortSourcesByAudioPreference(
			[source('de-1'), source('fr-1'), source('de-2'), source('fr-2')],
			pref
		);
		expect(sorted.map((s) => s.id)).toEqual(['fr-1', 'fr-2', 'de-1', 'de-2']);
	});

	it('does not mutate the input array', () => {
		const sources = [source('de'), source('ja')];
		sortSourcesByAudioPreference(sources, preference({ originalLanguage: 'ja' }));
		expect(sources.map((s) => s.id)).toEqual(['de', 'ja']);
	});
});

describe('resolveAudioPreferenceBucket', () => {
	it('classifies the four buckets', () => {
		const pref = preference({ originalLanguage: 'ja', languages: ['fr'] });
		expect(resolveAudioPreferenceBucket(source('jpn'), pref)).toBe(
			AUDIO_PREFERENCE_BUCKETS.original
		);
		expect(resolveAudioPreferenceBucket(source('fr-CA'), pref)).toBe(
			AUDIO_PREFERENCE_BUCKETS.preferred
		);
		expect(resolveAudioPreferenceBucket(source(), pref)).toBe(AUDIO_PREFERENCE_BUCKETS.untagged);
		expect(resolveAudioPreferenceBucket(source('de'), pref)).toBe(AUDIO_PREFERENCE_BUCKETS.other);
	});

	it('never reports an original match when preferOriginal is off or unknown', () => {
		expect(
			resolveAudioPreferenceBucket(
				source('ja'),
				preference({ preferOriginal: false, originalLanguage: 'ja' })
			)
		).toBe(AUDIO_PREFERENCE_BUCKETS.other);
		expect(resolveAudioPreferenceBucket(source('ja'), preference())).toBe(
			AUDIO_PREFERENCE_BUCKETS.other
		);
		expect(resolveAudioPreferenceBucket(source(), preference())).toBe(
			AUDIO_PREFERENCE_BUCKETS.untagged
		);
	});
});

describe('audioPreferencesEqual', () => {
	it('treats identical resolved preferences as equal', () => {
		expect(
			audioPreferencesEqual(
				{ preferOriginal: true, languages: ['ja', 'en'], originalLanguage: 'ja', mode: 'prefer' },
				{ preferOriginal: true, languages: ['ja', 'en'], originalLanguage: 'ja', mode: 'prefer' }
			)
		).toBe(true);
	});

	it('detects differences in any field, including order', () => {
		const base: EffectiveAudioPreference = {
			preferOriginal: true,
			languages: ['ja', 'en'],
			originalLanguage: 'ja',
			mode: 'prefer'
		};
		expect(audioPreferencesEqual(base, { ...base, preferOriginal: false })).toBe(false);
		expect(audioPreferencesEqual(base, { ...base, originalLanguage: null })).toBe(false);
		expect(audioPreferencesEqual(base, { ...base, languages: ['en', 'ja'] })).toBe(false);
		expect(audioPreferencesEqual(base, { ...base, languages: ['ja'] })).toBe(false);
	});

	it('treats null and undefined originalLanguage as equal', () => {
		expect(
			audioPreferencesEqual(
				{ preferOriginal: true, languages: [], originalLanguage: null, mode: 'prefer' },
				{
					preferOriginal: true,
					languages: [],
					originalLanguage: undefined as unknown as null,
					mode: 'prefer'
				}
			)
		).toBe(true);
	});
});

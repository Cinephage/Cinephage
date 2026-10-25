import { describe, it, expect } from 'vitest';
import type { EffectiveAudioPreference } from '#lib/server/languages/audio-preference.js';
import { evaluatePushLanguageGate } from './language-gate';

function preference(overrides: Partial<EffectiveAudioPreference> = {}): EffectiveAudioPreference {
	return {
		preferOriginal: false,
		languages: ['es', 'en'],
		originalLanguage: null,
		mode: 'prefer',
		...overrides
	};
}

describe('evaluatePushLanguageGate', () => {
	it('passes in prefer mode regardless of evidence', () => {
		expect(
			evaluatePushLanguageGate('Movie.2026.GERMAN.1080p.x264', preference({ mode: 'prefer' }))
		).toBeNull();
	});

	it('rejects an affirmatively contradicting title in require mode', () => {
		const reasons = evaluatePushLanguageGate(
			'Movie.2026.iTA-GERMAN.1080p.WEB-DL.x264',
			preference({ mode: 'require' })
		);
		expect(reasons).not.toBeNull();
		expect(reasons![0]).toContain('Audio language requirement not met');
	});

	it('passes untagged titles and multi packs (no proof pre-download)', () => {
		const require = preference({ mode: 'require' });
		expect(evaluatePushLanguageGate('Movie.2026.1080p.WEB-DL.x264', require)).toBeNull();
		expect(evaluatePushLanguageGate('Movie.2026.MULTi.1080p.WEB-DL.x264', require)).toBeNull();
	});

	it('passes titles evidencing a wanted language', () => {
		expect(
			evaluatePushLanguageGate(
				'Movie.2026.DUAL.ESP-ENG.1080p.WEB-DL',
				preference({ mode: 'require' })
			)
		).toBeNull();
	});
});

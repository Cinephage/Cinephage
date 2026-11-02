import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EffectiveAudioPreference } from '#lib/server/languages/audio-preference.js';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock('#lib/server/languages/audio-preference-resolver.js', () => ({
	resolveAudioPreferenceForItem: resolveMock
}));

import { LanguageStage } from './LanguageStage';
import type { GrabDecisionContext } from './types';

function preference(overrides: Partial<EffectiveAudioPreference> = {}): EffectiveAudioPreference {
	return {
		preferOriginal: false,
		languages: ['es', 'en'],
		originalLanguage: null,
		mode: 'prefer',
		...overrides
	};
}

function ctx(title: string, force = false): GrabDecisionContext {
	return {
		release: { title },
		target: { type: 'movie', movieId: 'movie-1' },
		existingFiles: [],
		profile: {} as GrabDecisionContext['profile'],
		options: force
			? ({ force: true } as GrabDecisionContext['options'])
			: ({} as GrabDecisionContext['options']),
		computed: {}
	};
}

let stage: LanguageStage;

beforeEach(() => {
	resolveMock.mockReset();
	stage = new LanguageStage();
});

describe('LanguageStage (require-mode gate)', () => {
	it('accepts everything in prefer mode (soft policy)', async () => {
		resolveMock.mockResolvedValue(preference({ mode: 'prefer' }));
		const result = await stage.evaluate(ctx('Movie.2026.GERMAN.1080p.x264-GROUP'));
		expect(result.accepted).toBe(true);
	});

	it('rejects an affirmatively contradicting title in require mode', async () => {
		resolveMock.mockResolvedValue(preference({ mode: 'require' }));
		const result = await stage.evaluate(ctx('Movie.2026.iTA-GERMAN.1080p.WEB-DL.x264-GROUP'));
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain('language requirement');
	});

	it('accepts an untagged title in require mode (no evidence, no rejection)', async () => {
		resolveMock.mockResolvedValue(preference({ mode: 'require' }));
		const result = await stage.evaluate(ctx('Movie.2026.1080p.WEB-DL.x264-GROUP'));
		expect(result.accepted).toBe(true);
	});

	it('accepts a multi-audio pack in require mode (contents unknowable)', async () => {
		resolveMock.mockResolvedValue(preference({ mode: 'require' }));
		const result = await stage.evaluate(ctx('Movie.2026.MULTi.1080p.WEB-DL.x264-GROUP'));
		expect(result.accepted).toBe(true);
	});

	it('accepts a title evidencing a preferred language in require mode', async () => {
		resolveMock.mockResolvedValue(preference({ mode: 'require' }));
		const result = await stage.evaluate(ctx('Movie.2026.DUAL.ESP-ENG.1080p.WEB-DL.x264'));
		expect(result.accepted).toBe(true);
	});

	it('accepts an original-audio match when preferOriginal is on', async () => {
		resolveMock.mockResolvedValue(
			preference({
				mode: 'require',
				preferOriginal: true,
				originalLanguage: 'ja',
				languages: []
			})
		);
		const result = await stage.evaluate(ctx('Show.2026.1080p.WEB-DL.JPN.AAC-GROUP'));
		expect(result.accepted).toBe(true);
	});

	it('skips when the preference has no expectation at all', async () => {
		resolveMock.mockResolvedValue(preference({ mode: 'require', languages: [] }));
		const result = await stage.evaluate(ctx('Movie.2026.GERMAN.1080p.x264-GROUP'));
		expect(result.accepted).toBe(true);
	});

	it('is disabled under force (manual override wins)', () => {
		expect(stage.isEnabled(ctx('Movie.2026.1080p.x264', true))).toBe(false);
	});
});

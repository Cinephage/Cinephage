import { describe, expect, it } from 'vitest';
import type {
	SubtitleAccessibility,
	SubtitleRequirement,
	SubtitleVariant
} from '#lib/shared/language-profile.js';
import { languageSatisfies, matchesRequirement, type SubtitleLike } from './requirement-matcher.js';

const req = (
	tag: string,
	variant: SubtitleVariant,
	accessibility: SubtitleAccessibility
): SubtitleRequirement => ({ tag, variant, accessibility });

const sub = (language: string, isForced = false, isHearingImpaired = false): SubtitleLike => ({
	language,
	isForced,
	isHearingImpaired
});

const VARIANTS: SubtitleVariant[] = ['regular', 'forced', 'both'];
const ACCESSIBILITIES: SubtitleAccessibility[] = ['any', 'prefer-hi', 'require-hi', 'exclude-hi'];

/** [isForced, isHearingImpaired] */
const FLAG_COMBOS: [boolean, boolean][] = [
	[false, false],
	[false, true],
	[true, false],
	[true, true]
];

/**
 * Expected satisfaction per cell, aligned with FLAG_COMBOS order.
 * Derived from: variant filters forced/regular; require-hi needs HI;
 * exclude-hi rejects HI; any/prefer-hi accept both HI values.
 */
const TRUTH_TABLE: Record<SubtitleVariant, Record<SubtitleAccessibility, boolean[]>> = {
	regular: {
		any: [true, true, false, false],
		'prefer-hi': [true, true, false, false],
		'require-hi': [false, true, false, false],
		'exclude-hi': [true, false, false, false]
	},
	forced: {
		any: [false, false, true, true],
		'prefer-hi': [false, false, true, true],
		'require-hi': [false, false, false, true],
		'exclude-hi': [false, false, true, false]
	},
	both: {
		any: [true, true, true, true],
		'prefer-hi': [true, true, true, true],
		'require-hi': [false, true, false, true],
		'exclude-hi': [true, false, true, false]
	}
};

describe('matchesRequirement variant × accessibility truth table', () => {
	for (const variant of VARIANTS) {
		for (const accessibility of ACCESSIBILITIES) {
			it(`${variant} × ${accessibility}`, () => {
				const expected = TRUTH_TABLE[variant][accessibility];
				FLAG_COMBOS.forEach(([isForced, isHearingImpaired], index) => {
					const actual = matchesRequirement(
						{ language: 'en', isForced, isHearingImpaired },
						req('en', variant, accessibility)
					);
					expect(
						actual,
						`forced=${isForced} hi=${isHearingImpaired} expected ${expected[index]}`
					).toBe(expected[index]);
				});
			});
		}
	}
});

describe('languageSatisfies', () => {
	it('accepts any region/script for a base-only requirement', () => {
		expect(languageSatisfies('en', 'en')).toBe(true);
		expect(languageSatisfies('en-US', 'en')).toBe(true);
		expect(languageSatisfies('en-GB', 'en')).toBe(true);
		expect(languageSatisfies('EN', 'en')).toBe(true);
		expect(languageSatisfies('zh-Hans', 'zh')).toBe(true);
		expect(languageSatisfies('zh-Hant', 'zh')).toBe(true);
		expect(languageSatisfies('zh-CN', 'zh')).toBe(true);
		expect(languageSatisfies('pt-BR', 'pt')).toBe(true);
		expect(languageSatisfies('pt-PT', 'pt')).toBe(true);
		expect(languageSatisfies('pt', 'pt')).toBe(true);
	});

	it('requires the exact canonical tag for a regional requirement', () => {
		expect(languageSatisfies('pt-BR', 'pt-BR')).toBe(true);
		expect(languageSatisfies('pt-br', 'pt-BR')).toBe(true);
		expect(languageSatisfies('pob', 'pt-BR')).toBe(true);
		expect(languageSatisfies('pt-PT', 'pt-BR')).toBe(false);
		expect(languageSatisfies('pt-BR', 'pt-PT')).toBe(false);
	});

	it('never lets a bare base satisfy a regional requirement', () => {
		expect(languageSatisfies('pt', 'pt-BR')).toBe(false);
		expect(languageSatisfies('en', 'en-US')).toBe(false);
		expect(languageSatisfies('en', 'en-GB')).toBe(false);
		expect(languageSatisfies('es', 'es-419')).toBe(false);
		expect(languageSatisfies('zh', 'zh-Hant')).toBe(false);
	});

	it('maps region aliases onto script requirements via canonicalization', () => {
		expect(languageSatisfies('zh-Hans', 'zh-Hans')).toBe(true);
		expect(languageSatisfies('zh-CN', 'zh-Hans')).toBe(true);
		expect(languageSatisfies('zh-Hant', 'zh-Hant')).toBe(true);
		expect(languageSatisfies('zh-TW', 'zh-Hant')).toBe(true);
		expect(languageSatisfies('zh-Hans', 'zh-Hant')).toBe(false);
		expect(languageSatisfies('zh-Hant', 'zh-Hans')).toBe(false);
		expect(languageSatisfies('zh-CN', 'zh-Hant')).toBe(false);
	});

	it('matches es-419 only exactly (including alias)', () => {
		expect(languageSatisfies('es-419', 'es-419')).toBe(true);
		expect(languageSatisfies('es-la', 'es-419')).toBe(true);
		expect(languageSatisfies('es-ES', 'es-419')).toBe(false);
	});

	it('never lets und or unresolvable input satisfy a requirement', () => {
		expect(languageSatisfies('und', 'en')).toBe(false);
		expect(languageSatisfies('en', 'und')).toBe(false);
		expect(languageSatisfies('und', 'und')).toBe(false);
		expect(languageSatisfies('', 'en')).toBe(false);
		expect(languageSatisfies('not a language', 'en')).toBe(false);
		expect(languageSatisfies('xx-zz', 'en')).toBe(false);
		expect(languageSatisfies('en', '')).toBe(false);
		expect(languageSatisfies('en', 'not a language')).toBe(false);
	});
});

describe('variant precedence', () => {
	it('a regular subtitle never satisfies a forced requirement', () => {
		expect(matchesRequirement(sub('en', false, false), req('en', 'forced', 'any'))).toBe(false);
	});

	it('a forced subtitle never satisfies a regular requirement', () => {
		expect(matchesRequirement(sub('en', true, false), req('en', 'regular', 'any'))).toBe(false);
	});

	it('a both requirement is accepted by regular and forced subtitles', () => {
		expect(matchesRequirement(sub('en', false, false), req('en', 'both', 'any'))).toBe(true);
		expect(matchesRequirement(sub('en', true, false), req('en', 'both', 'any'))).toBe(true);
	});

	it('regular and forced requirements accept their own variant', () => {
		expect(matchesRequirement(sub('en', false, false), req('en', 'regular', 'any'))).toBe(true);
		expect(matchesRequirement(sub('en', true, false), req('en', 'forced', 'any'))).toBe(true);
	});

	it('keeps language identity independent of variant flags', () => {
		expect(matchesRequirement(sub('en-US', true, false), req('en', 'forced', 'any'))).toBe(true);
		expect(matchesRequirement(sub('en-GB', false, false), req('en', 'regular', 'any'))).toBe(true);
	});
});

describe('null/undefined flags are treated as false', () => {
	it('treats missing flags as non-forced and non-HI', () => {
		expect(matchesRequirement({ language: 'en' }, req('en', 'regular', 'any'))).toBe(true);
		expect(matchesRequirement({ language: 'en' }, req('en', 'regular', 'exclude-hi'))).toBe(true);
		expect(matchesRequirement({ language: 'en' }, req('en', 'regular', 'require-hi'))).toBe(false);
		expect(matchesRequirement({ language: 'en' }, req('en', 'forced', 'any'))).toBe(false);
	});

	it('treats explicit null flags as false', () => {
		const subtitle: SubtitleLike = { language: 'en', isForced: null, isHearingImpaired: null };
		expect(matchesRequirement(subtitle, req('en', 'regular', 'any'))).toBe(true);
		expect(matchesRequirement(subtitle, req('en', 'regular', 'exclude-hi'))).toBe(true);
		expect(matchesRequirement(subtitle, req('en', 'regular', 'require-hi'))).toBe(false);
		expect(matchesRequirement(subtitle, req('en', 'forced', 'any'))).toBe(false);
	});
});

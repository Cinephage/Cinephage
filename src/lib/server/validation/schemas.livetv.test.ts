import { describe, expect, it } from 'vitest';

import { liveTvAccountCreateSchema, stalkerLanguageSchema } from './schemas.js';

function createStalkerBody(stalkerConfig: Record<string, unknown>): Record<string, unknown> {
	return {
		name: 'My Portal',
		providerType: 'stalker',
		stalkerConfig
	};
}

describe('stalkerLanguageSchema', () => {
	it('accepts 2-letter codes and canonicalizes case', () => {
		expect(stalkerLanguageSchema.parse('en')).toBe('en');
		expect(stalkerLanguageSchema.parse('RU')).toBe('ru');
	});

	it('reduces regional variants and script tags to the base code', () => {
		expect(stalkerLanguageSchema.parse('pt-BR')).toBe('pt');
		expect(stalkerLanguageSchema.parse('zh-Hans')).toBe('zh');
	});

	it('resolves ISO 639-2/3 aliases', () => {
		expect(stalkerLanguageSchema.parse('ger')).toBe('de');
	});

	it('rejects unrecognizable language values', () => {
		expect(stalkerLanguageSchema.safeParse('klingon').success).toBe(false);
		expect(stalkerLanguageSchema.safeParse('42').success).toBe(false);
		expect(stalkerLanguageSchema.safeParse('').success).toBe(false);
	});
});

describe('liveTvAccountCreateSchema stalker language', () => {
	it('accepts a valid language and canonicalizes it', () => {
		const result = liveTvAccountCreateSchema.safeParse(
			createStalkerBody({
				portalUrl: 'http://portal.example.com/c',
				macAddress: '00:1A:79:00:00:01',
				language: 'pt-BR'
			})
		);

		expect(result.success).toBe(true);
		if (!result.success) {
			return;
		}
		expect(result.data.stalkerConfig?.language).toBe('pt');
	});

	it('defaults the language to English when the field is absent', () => {
		const result = liveTvAccountCreateSchema.safeParse(
			createStalkerBody({
				portalUrl: 'http://portal.example.com/c',
				macAddress: '00:1A:79:00:00:01'
			})
		);

		expect(result.success).toBe(true);
		if (!result.success) {
			return;
		}
		expect(result.data.stalkerConfig?.language).toBe('en');
	});

	it('rejects an unrecognizable language', () => {
		const result = liveTvAccountCreateSchema.safeParse(
			createStalkerBody({
				portalUrl: 'http://portal.example.com/c',
				macAddress: '00:1A:79:00:00:01',
				language: 'not-a-language'
			})
		);

		expect(result.success).toBe(false);
	});
});

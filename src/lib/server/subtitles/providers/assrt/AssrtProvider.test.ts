import { describe, expect, it } from 'vitest';

import { mapAssrtLanguage } from './AssrtProvider';

describe('mapAssrtLanguage', () => {
	it('resolves ISO-639-3 style codes through the canonical registry', () => {
		expect(mapAssrtLanguage(['eng'], ['en'])).toBe('en');
		expect(mapAssrtLanguage(['jpn'], ['ja'])).toBe('ja');
		expect(mapAssrtLanguage(['chi'], ['zh'])).toBe('zh');
	});

	it('canonicalizes traditional Chinese', () => {
		expect(mapAssrtLanguage(['cht'], ['zh-Hant'])).toBe('zh-Hant');
	});

	it('prefers a language the caller requested when the list carries several', () => {
		expect(mapAssrtLanguage(['eng', 'cht'], ['zh-Hant'])).toBe('zh-Hant');
		expect(mapAssrtLanguage(['eng', 'cht'], ['en'])).toBe('en');
	});

	it('defaults to Chinese for an empty or unrecognized list', () => {
		expect(mapAssrtLanguage([], ['en'])).toBe('zh');
		expect(mapAssrtLanguage(['x-not-a-language'], ['en'])).toBe('zh');
	});
});

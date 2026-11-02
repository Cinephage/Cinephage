import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	clearLocalizationCaches,
	extractLanguageCodes,
	resolveLocalizedTitles,
	resolveRequestLocale
} from './localization';
import { coreTokens } from './tokens/definitions/core';

const tmdbFetch = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		fetch: tmdbFetch
	}
}));

describe('extractLanguageCodes', () => {
	it('extracts language codes from format string', () => {
		expect(extractLanguageCodes('{Title:ES} ({Year})')).toEqual(['es']);
	});

	it('extracts multiple unique codes', () => {
		expect(extractLanguageCodes('{Title:ES} - {CleanTitle:FR}')).toEqual(['es', 'fr']);
	});

	it('deduplicates codes', () => {
		expect(extractLanguageCodes('{Title:ES} - {CleanTitle:ES}')).toEqual(['es']);
	});

	it('returns empty for no language tokens', () => {
		expect(extractLanguageCodes('{Title} ({Year})')).toEqual([]);
	});

	it('handles case-insensitive codes', () => {
		expect(extractLanguageCodes('{Title:es}')).toEqual(['es']);
	});
});

describe('resolveRequestLocale', () => {
	beforeEach(() => {
		clearLocalizationCaches();
	});

	it('derives ja-JP from ja via likely-subtag maximization', () => {
		expect(resolveRequestLocale('ja')).toBe('ja-JP');
	});

	it('derives en-US from en and de-DE from de', () => {
		expect(resolveRequestLocale('en')).toBe('en-US');
		expect(resolveRequestLocale('de')).toBe('de-DE');
	});

	it('maps zh to zh-CN via the explicit script map', () => {
		expect(resolveRequestLocale('zh')).toBe('zh-CN');
	});

	it('maps zh-Hans and zh-Hant explicitly', () => {
		expect(resolveRequestLocale('zh-Hans')).toBe('zh-CN');
		expect(resolveRequestLocale('zh-Hant')).toBe('zh-TW');
	});

	it('handles 3-letter ISO codes via the shared registry (deu -> de-DE)', () => {
		expect(resolveRequestLocale('deu')).toBe('de-DE');
	});

	it('returns null for unknown codes so the fetch is skipped', () => {
		expect(resolveRequestLocale('xx')).toBeNull();
	});

	it('returns null for the undetermined marker', () => {
		expect(resolveRequestLocale('und')).toBeNull();
	});

	it('never injects a script subtag TMDB cannot parse', () => {
		const locale = resolveRequestLocale('ja');
		expect(locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
	});
});

describe('resolveLocalizedTitles', () => {
	beforeEach(() => {
		clearLocalizationCaches();
		tmdbFetch.mockReset();
	});

	it('fetches movie details with the derived locale and returns the localized title', async () => {
		tmdbFetch.mockResolvedValue({ title: '千と千尋の神隠し' });

		const result = await resolveLocalizedTitles(129, ['ja'], 'movie');

		expect(tmdbFetch).toHaveBeenCalledWith('/movie/129?language=ja-JP', {}, true);
		expect(result).toEqual({ ja: '千と千尋の神隠し' });
	});

	it('uses the tv endpoint and name field for series', async () => {
		tmdbFetch.mockResolvedValue({ name: '進撃の巨人' });

		const result = await resolveLocalizedTitles(1429, ['ja'], 'series');

		expect(tmdbFetch).toHaveBeenCalledWith('/tv/1429?language=ja-JP', {}, true);
		expect(result).toEqual({ ja: '進撃の巨人' });
	});

	it('skips the fetch entirely for codes with no valid locale', async () => {
		const result = await resolveLocalizedTitles(123, ['xx', 'und']);

		expect(tmdbFetch).not.toHaveBeenCalled();
		expect(result).toEqual({});
	});

	it('caches per title + language so repeat calls do not refetch', async () => {
		tmdbFetch.mockResolvedValue({ title: 'El club de la lucha' });

		await resolveLocalizedTitles(550, ['es']);
		await resolveLocalizedTitles(550, ['es']);

		expect(tmdbFetch).toHaveBeenCalledTimes(1);

		// A different title gets its own cache entry.
		await resolveLocalizedTitles(155, ['es']);
		expect(tmdbFetch).toHaveBeenCalledTimes(2);
	});

	it('falls back to the base title when the fetch fails or carries no title', async () => {
		tmdbFetch.mockRejectedValueOnce(new Error('TMDB offline'));
		expect(await resolveLocalizedTitles(129, ['ja'])).toEqual({});

		tmdbFetch.mockResolvedValueOnce({});
		expect(await resolveLocalizedTitles(155, ['ja'])).toEqual({});
		expect(tmdbFetch).toHaveBeenCalledTimes(2);
	});
});

describe('Language-aware title tokens', () => {
	const titleToken = coreTokens.find((t) => t.name === 'Title')!;
	const cleanToken = coreTokens.find((t) => t.name === 'CleanTitle')!;

	it('Title with language code returns localized title', () => {
		expect(
			titleToken.render(
				{ title: 'Fight Club', localizedTitles: { es: 'El club de la lucha' } },
				{} as any,
				'ES'
			)
		).toBe('El club de la lucha');
	});

	it('Title falls back to default when language not in map', () => {
		expect(
			titleToken.render(
				{ title: 'Fight Club', localizedTitles: { es: 'El club de la lucha' } },
				{} as any,
				'FR'
			)
		).toBe('Fight Club');
	});

	it('Title without format spec returns default title', () => {
		expect(
			titleToken.render(
				{ title: 'Fight Club', localizedTitles: { es: 'El club de la lucha' } },
				{} as any
			)
		).toBe('Fight Club');
	});

	it('CleanTitle with language code returns localized clean title', () => {
		expect(
			cleanToken.render(
				{ title: 'Fight Club', localizedTitles: { es: 'El club de la lucha: Editado' } },
				{} as any,
				'ES'
			)
		).toBe('El club de la lucha: Editado');
	});

	it('numeric format spec is not treated as language code', () => {
		expect(
			titleToken.render({ title: 'Test', localizedTitles: { '00': 'Wrong' } }, {} as any, '00')
		).toBe('Test');
	});
});

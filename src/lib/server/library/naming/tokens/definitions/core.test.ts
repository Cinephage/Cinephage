import { describe, it, expect } from 'vitest';
import { coreTokens } from './core';

describe('OriginalTitle token', () => {
	const originalTitleToken = coreTokens.find((t) => t.name === 'OriginalTitle')!;
	const originalCleanTitleToken = coreTokens.find((t) => t.name === 'OriginalCleanTitle')!;

	describe('{OriginalTitle}', () => {
		it('renders info.originalTitle when present', () => {
			expect(
				originalTitleToken.render(
					{ title: 'English Title', originalTitle: 'Original Name' },
					{} as any
				)
			).toBe('Original Name');
		});

		it('falls back to info.title when originalTitle is undefined', () => {
			expect(originalTitleToken.render({ title: 'English Title' }, {} as any)).toBe(
				'English Title'
			);
		});

		it('returns empty string when both title and originalTitle are empty/undefined', () => {
			expect(originalTitleToken.render({ title: '' }, {} as any)).toBe('');

			// When title is explicitly undefined (unlikely but handled)
			expect(originalTitleToken.render({ title: undefined as any }, {} as any)).toBe('');
		});

		it('does NOT support locale format spec', () => {
			expect(originalTitleToken.supportsFormatSpec).toBeFalsy();
		});

		it('ignores format spec argument even if passed', () => {
			expect(
				originalTitleToken.render({ title: 'Title', originalTitle: 'Original' }, {} as any, 'ES')
			).toBe('Original');
		});

		it('has correct metadata', () => {
			expect(originalTitleToken.name).toBe('OriginalTitle');
			expect(originalTitleToken.aliases).toEqual([
				'SeriesOriginalTitle',
				'MovieOriginalTitle',
				'Movie OriginalTitle',
				'Series OriginalTitle'
			]);
			expect(originalTitleToken.category).toBe('core');
			expect(originalTitleToken.applicability).toEqual(['movie', 'series']);
		});

		it('is NOT applicable to episodes (TMDB has no original_name for episodes)', () => {
			expect(originalTitleToken.applicability).not.toContain('episode');
		});
	});

	describe('{OriginalCleanTitle}', () => {
		it('renders cleaned info.originalTitle when present - removes special chars but preserves colons', () => {
			expect(
				originalCleanTitleToken.render(
					{ title: 'Fallback', originalTitle: 'The Movie?' },
					{} as any
				)
			).toBe('The Movie');

			// Colons are preserved (handled downstream by colonReplacement)
			expect(
				originalCleanTitleToken.render(
					{ title: 'Fallback', originalTitle: 'Star Wars: A New Hope' },
					{} as any
				)
			).toBe('Star Wars: A New Hope');

			// Multiple special characters removed
			expect(
				originalCleanTitleToken.render(
					{ title: 'Fallback', originalTitle: 'Film "Name" <Test> |Bad?' },
					{} as any
				)
			).toBe('Film Name Test Bad');
		});

		it('falls back to cleaned info.title when originalTitle is undefined', () => {
			expect(originalCleanTitleToken.render({ title: 'The Movie?' }, {} as any)).toBe('The Movie');
		});

		it('returns empty string when both title and originalTitle are empty/undefined', () => {
			expect(originalCleanTitleToken.render({ title: '' }, {} as any)).toBe('');

			expect(originalCleanTitleToken.render({ title: undefined as any }, {} as any)).toBe('');
		});

		it('handles title with only special characters correctly', () => {
			expect(
				originalCleanTitleToken.render({ title: 'Fallback', originalTitle: '?@#$%' }, {} as any)
			).toBe('@#$%');
		});

		it('does NOT support locale format spec', () => {
			expect(originalCleanTitleToken.supportsFormatSpec).toBeFalsy();
		});

		it('has correct metadata', () => {
			expect(originalCleanTitleToken.name).toBe('OriginalCleanTitle');
			expect(originalCleanTitleToken.aliases).toEqual([
				'SeriesOriginalCleanTitle',
				'MovieOriginalCleanTitle'
			]);
			expect(originalCleanTitleToken.category).toBe('core');
			expect(originalCleanTitleToken.applicability).toEqual(['movie', 'series']);
		});

		it('is NOT applicable to episodes', () => {
			expect(originalCleanTitleToken.applicability).not.toContain('episode');
		});
	});

	describe('Existing core tokens remain intact', () => {
		it('Title token still exists', () => {
			const titleToken = coreTokens.find((t) => t.name === 'Title');
			expect(titleToken).toBeDefined();
		});

		it('CleanTitle token still exists', () => {
			const cleanToken = coreTokens.find((t) => t.name === 'CleanTitle');
			expect(cleanToken).toBeDefined();
		});

		it('Year token still exists', () => {
			const yearToken = coreTokens.find((t) => t.name === 'Year');
			expect(yearToken).toBeDefined();
		});
	});

	describe(':First format spec (first-letter organization, issue #497)', () => {
		const titleToken = coreTokens.find((t) => t.name === 'Title')!;
		const cleanTitleToken = coreTokens.find((t) => t.name === 'CleanTitle')!;
		const originalTitleToken = coreTokens.find((t) => t.name === 'OriginalTitle')!;
		const originalCleanTitleToken = coreTokens.find((t) => t.name === 'OriginalCleanTitle')!;

		it('{Title:First} returns first alphanumeric character uppercased', () => {
			expect(titleToken.render({ title: 'the matrix' }, {} as any, 'First')).toBe('T');
			expect(titleToken.render({ title: 'The Matrix' }, {} as any, 'First')).toBe('T');
			expect(titleToken.render({ title: '7 Days' }, {} as any, 'First')).toBe('7');
			expect(titleToken.render({ title: '!!!Bang' }, {} as any, 'First')).toBe('B');
			expect(titleToken.render({ title: 'THE MATRIX' }, {} as any, 'first')).toBe('T');
		});

		it('{Title:First} returns empty string for empty title', () => {
			expect(titleToken.render({ title: '' }, {} as any, 'First')).toBe('');
			expect(titleToken.render({ title: '!!!' }, {} as any, 'First')).toBe('');
		});

		it('{CleanTitle:First} uses the cleaned title', () => {
			expect(cleanTitleToken.render({ title: 'The Matrix?' }, {} as any, 'First')).toBe('T');
			expect(cleanTitleToken.render({ title: '' }, {} as any, 'First')).toBe('');
		});

		it('{OriginalTitle:First} uses the original title', () => {
			expect(
				originalTitleToken.render(
					{ title: 'Fallback', originalTitle: 'Crouching Tiger, Hidden Dragon' },
					{} as any,
					'First'
				)
			).toBe('C');
		});

		it('{OriginalCleanTitle:First} uses the cleaned original title', () => {
			expect(
				originalCleanTitleToken.render(
					{ title: 'Fallback', originalTitle: 'Sen to Chihiro' },
					{} as any,
					'First'
				)
			).toBe('S');
		});

		it('language-code specs still work for {Title:ES}', () => {
			expect(
				titleToken.render(
					{ title: 'English Title', localizedTitles: { es: 'Título' } },
					{} as any,
					'ES'
				)
			).toBe('Título');
		});
	});
});

import { describe, expect, it } from 'vitest';
import {
	canonicalizeArticleTitle,
	calculateMatchConfidence,
	normalizeTitleForMatch
} from './title-matching.js';

describe('canonicalizeArticleTitle', () => {
	it('moves a trailing comma-form article to the front', () => {
		expect(canonicalizeArticleTitle('Lion King, The')).toBe('The Lion King');
		expect(canonicalizeArticleTitle('wolf of wall street, the')).toBe('The wolf of wall street');
		expect(canonicalizeArticleTitle('Mullahs, An')).toBe('An Mullahs');
	});

	it('leaves titles without a trailing article untouched', () => {
		expect(canonicalizeArticleTitle('The Lion King')).toBe('The Lion King');
		expect(canonicalizeArticleTitle('The Matrix')).toBe('The Matrix');
		expect(canonicalizeArticleTitle('Alien')).toBe('Alien');
		expect(canonicalizeArticleTitle('The Office Us')).toBe('The Office Us');
	});

	it('does not rewrite a bare article', () => {
		expect(canonicalizeArticleTitle(', The')).toBe(', The');
	});
});

describe('normalizeTitleForMatch', () => {
	it('canonicalizes inverted-article and leading-article forms to the same string', () => {
		expect(normalizeTitleForMatch('Lion King, The')).toBe(normalizeTitleForMatch('The Lion King'));
		expect(normalizeTitleForMatch('Lion King, The')).toBe('lionking');
	});

	it('keeps existing leading-article behavior', () => {
		expect(normalizeTitleForMatch('The Matrix')).toBe('matrix');
		expect(normalizeTitleForMatch('An American Tale')).toBe('americantale');
	});
});

describe('calculateMatchConfidence', () => {
	it('scores against the TMDB original title when the localized title differs', () => {
		const score = calculateMatchConfidence(
			'Im Labyrinth des Schweigens',
			2010,
			'Labyrinth of Lies',
			2010,
			'Im Labyrinth des Schweigens'
		);
		expect(score).toBeGreaterThanOrEqual(0.8);
	});

	it('prefers the better of localized and original title similarity', () => {
		const withOriginal = calculateMatchConfidence(
			'Im Labyrinth des Schweigens',
			undefined,
			'Labyrinth of Lies',
			undefined,
			'Im Labyrinth des Schweigens'
		);
		const withoutOriginal = calculateMatchConfidence(
			'Im Labyrinth des Schweigens',
			undefined,
			'Labyrinth of Lies',
			undefined
		);
		expect(withOriginal).toBeGreaterThan(withoutOriginal);
	});

	it('still boosts exact normalized matches to 0.95 for inverted articles', () => {
		const score = calculateMatchConfidence(
			'Lion King, The',
			undefined,
			'The Lion King',
			undefined,
			'The Lion King'
		);
		expect(score).toBeGreaterThanOrEqual(0.95);
	});

	it('does not let an exact-title match override a clear year mismatch (GitHub #595)', () => {
		// "Maigret" (2025) vs. TMDB's unrelated "Maigret" (1981): identical
		// titles used to unconditionally floor the score at 0.95, silently
		// erasing the year-mismatch penalty and auto-matching the wrong show.
		const score = calculateMatchConfidence('Maigret', 2025, 'Maigret', 1981);
		expect(score).toBeLessThan(0.8); // below DEFAULT_MATCH_THRESHOLD
	});

	it('still applies the exact-title boost when years are close (within 1)', () => {
		const score = calculateMatchConfidence('Maigret', 2025, 'Maigret', 2024);
		expect(score).toBeGreaterThanOrEqual(0.95);
	});

	it('still applies the exact-title boost when one year is unknown', () => {
		const score = calculateMatchConfidence('Maigret', undefined, 'Maigret', 1981);
		expect(score).toBeGreaterThanOrEqual(0.95);
	});

	it('keeps the year boost and mismatch penalty behavior', () => {
		const boosted = calculateMatchConfidence('Some Title', 2010, 'Some Title', 2010);
		const penalized = calculateMatchConfidence('Completely Different', 1990, 'Some Title', 2010);
		expect(boosted).toBe(1);
		expect(penalized).toBeLessThan(0.5);
	});
});

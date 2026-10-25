import { describe, expect, it } from 'vitest';
import {
	matchReleaseToTarget,
	matchTitleContainment,
	normalizeIdentityTitle,
	titleTokens
} from './release-identity.js';

describe('titleTokens', () => {
	it('folds diacritics, punctuation and case', () => {
		expect(titleTokens('The Déjà-Vu: A Movie!')).toEqual(['deja', 'vu', 'a', 'movie']);
	});

	it('drops leading articles only', () => {
		expect(titleTokens('A Quiet Place')).toEqual(['quiet', 'place']);
		expect(titleTokens('Lion King, The')).toEqual(['lion', 'king', 'the']);
	});

	it('handles unicode scripts', () => {
		// й NFD-folds to и + combining breve, which the diacritic strip removes.
		expect(titleTokens('Демон-слээйер')).toEqual(['демон', 'слээиер']);
	});
});

describe('normalizeIdentityTitle', () => {
	it('produces de-punctuated joined form', () => {
		expect(normalizeIdentityTitle('Spider-Man: No Way Home')).toBe('spidermannowayhome');
	});
});

describe('matchReleaseToTarget', () => {
	it('matches exact normalized titles', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Spider-Man No Way Home',
			targetTitles: ['Spider-Man: No Way Home'],
			releaseYear: 2021,
			targetYear: 2021
		});
		expect(result.matched).toBe(true);
		expect(result.method).toBe('exact');
	});

	it('matches via similarity across punctuation and articles', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Mission Impossible Fallout',
			targetTitles: ['Mission: Impossible - Fallout'],
			releaseYear: 2018,
			targetYear: 2018
		});
		expect(result.matched).toBe(true);
	});

	it('matches against any candidate (original title, alternates)', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Case Closed',
			targetTitles: ['Detective Conan', 'Case Closed'],
			targetYear: 1996
		});
		expect(result.matched).toBe(true);
	});

	// The 2026-09-17 incident: substring containment matched "Halloween"
	// (1978) to "Detective Conan: The Bride of Halloween" (2022).
	it('rejects Halloween vs Detective Conan: The Bride of Halloween', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Detective Conan The Bride of Halloween',
			targetTitles: ['Halloween'],
			releaseYear: 2022,
			targetYear: 1978
		});
		expect(result.matched).toBe(false);
		// Title similarity is far below threshold, so the title check fails
		// before year arbitration is even reached.
		expect(result.reason).toBe('title_mismatch');
	});

	it('rejects Halloween vs Bride of Halloween even without years', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Detective Conan The Bride of Halloween',
			targetTitles: ['Halloween']
		});
		expect(result.matched).toBe(false);
		expect(result.reason).toBe('title_mismatch');
	});

	it('rejects Blade vs Blade Runner (token containment is not identity)', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Blade Runner 2049',
			targetTitles: ['Blade'],
			releaseYear: 2017,
			targetYear: 1998
		});
		expect(result.matched).toBe(false);
	});

	it('rejects Blade vs Blade Runner even with no year evidence', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Blade Runner',
			targetTitles: ['Blade']
		});
		expect(result.matched).toBe(false);
		expect(result.reason).toBe('title_mismatch');
	});

	it('rejects Dune vs Dune Part Two', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Dune Part Two',
			targetTitles: ['Dune'],
			releaseYear: 2024,
			targetYear: 2021
		});
		expect(result.matched).toBe(false);
	});

	it('rejects on year mismatch beyond ±1', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Halloween',
			targetTitles: ['Halloween'],
			releaseYear: 2018,
			targetYear: 1978
		});
		expect(result.matched).toBe(false);
		expect(result.reason).toBe('year_mismatch');
	});

	it('tolerates ±1 year (festival vs wide release)', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Halloween',
			targetTitles: ['Halloween'],
			releaseYear: 1979,
			targetYear: 1978
		});
		expect(result.matched).toBe(true);
	});

	it('forward-drift mode accepts later years for season packs', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Show Name',
			targetTitles: ['Show Name'],
			releaseYear: 2017,
			targetYear: 2015,
			yearMode: 'forward-drift'
		});
		expect(result.matched).toBe(true);
	});

	it('forward-drift mode still rejects earlier years', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Show Name',
			targetTitles: ['Show Name'],
			releaseYear: 2013,
			targetYear: 2015,
			yearMode: 'forward-drift'
		});
		expect(result.matched).toBe(false);
		expect(result.reason).toBe('year_mismatch');
	});

	it('missing year on either side is not a mismatch (caller policy decides)', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Halloween',
			targetTitles: ['Halloween'],
			releaseYear: undefined,
			targetYear: 1978
		});
		expect(result.matched).toBe(true);
	});

	it('returns no_candidates for empty target list', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Anything',
			targetTitles: ['  ']
		});
		expect(result.matched).toBe(false);
		expect(result.reason).toBe('no_candidates');
	});

	it('rejects unmappable localized titles instead of passing them', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Невеста Хэллоуина',
			targetTitles: ['Halloween']
		});
		expect(result.matched).toBe(false);
	});

	it('matches localized titles when the alternate title is a candidate', () => {
		const result = matchReleaseToTarget({
			releaseTitle: 'Невеста Хэллоуина',
			targetTitles: ['Detective Conan: The Bride of Halloween', 'Невеста Хэллоуина']
		});
		expect(result.matched).toBe(true);
		expect(result.method).toBe('exact');
	});

	it('matches a dual-language release title against its primary segment (GitHub report)', () => {
		// The release joins a Russian primary title with its English
		// alternate via " / "; comparing the whole string against the
		// library's Russian-only title dragged similarity down to 0.65
		// (below the 0.7 threshold) because of the extra English tokens.
		const result = matchReleaseToTarget({
			releaseTitle: 'Зловещие Мертвецы 3: Армия Тьмы / Army of Darkness',
			targetTitles: ['Зловещие мертвецы 3: Армия тьмы'],
			releaseYear: 1992,
			targetYear: 1992
		});
		expect(result.matched).toBe(true);
		expect(result.method).toBe('exact');
		expect(result.bestSimilarity).toBe(1);
	});

	it('matches a dual-language release title against its alternate segment', () => {
		// Same join format, but this time the LIBRARY title is the English
		// one; the primary (Russian) segment alone would score low, so the
		// alternate segment must be tried too.
		const result = matchReleaseToTarget({
			releaseTitle: 'Сталкер / Stalker',
			targetTitles: ['Stalker'],
			releaseYear: 1979,
			targetYear: 1979
		});
		expect(result.matched).toBe(true);
		expect(result.method).toBe('exact');
	});
});

describe('matchTitleContainment (display-only)', () => {
	it('allows one extra descriptor token on multi-token titles', () => {
		expect(matchTitleContainment('Show Name Special', 'Show Name').contained).toBe(true);
	});

	it('never contains single-token titles', () => {
		expect(matchTitleContainment('Blade Runner', 'Blade').contained).toBe(false);
		expect(
			matchTitleContainment('Detective Conan The Bride of Halloween', 'Halloween').contained
		).toBe(false);
	});

	it('rejects containment with more than one extra token', () => {
		expect(matchTitleContainment('Show Name Very Special Edition', 'Show Name').contained).toBe(
			false
		);
	});

	it('is order agnostic', () => {
		expect(matchTitleContainment('Show Name', 'Show Name Special').contained).toBe(true);
	});
});

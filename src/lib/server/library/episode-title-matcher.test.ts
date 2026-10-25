import { describe, expect, it } from 'vitest';
import { matchSpecialEpisodeByTitle } from './episode-title-matcher';

// Fixtures below are LIVE TMDB season-0 data, verified 2026-09-20:
// Battlestar Galactica tmdb 1972, Pokémon tmdb 60572, The Blue Planet tmdb
// 13579, Firefly tmdb 1437. Do not "fix" titles to match expectations —
// change the matcher instead.

const bsgSpecials = [
	{ seasonNumber: 0, episodeNumber: 2, title: 'The Resistance (1)', airDate: '2006-09-05' },
	{ seasonNumber: 0, episodeNumber: 19, title: 'Razor (1)', airDate: '2007-11-24' },
	{ seasonNumber: 0, episodeNumber: 20, title: 'Razor (2)', airDate: '2007-11-24' },
	{ seasonNumber: 0, episodeNumber: 24, title: 'Face of the Enemy (1)', airDate: '2008-12-12' },
	{ seasonNumber: 0, episodeNumber: 35, title: 'The Last Frakkin Special', airDate: '2009-03-16' },
	{ seasonNumber: 0, episodeNumber: 38, title: 'The Journey', airDate: null },
	{ seasonNumber: 0, episodeNumber: 47, title: 'The Journey Ends - The Arrival', airDate: null }
];

const pokemonSpecials = [
	{ seasonNumber: 0, episodeNumber: 13, title: 'Pokémon: Mewtwo Returns', airDate: '2000-12-30' },
	{
		seasonNumber: 0,
		episodeNumber: 18,
		title: 'Pokémon: The Mastermind of Mirage Pokémon',
		airDate: '2006-04-29'
	}
];

describe('episode-title-matcher (season 0 specials)', () => {
	it('matches "Razor (2007)" via containment — "razor2" is contained in "razor2007", "razor1" is not', () => {
		const match = matchSpecialEpisodeByTitle(
			bsgSpecials,
			['Razor (2007)'],
			2007,
			'Battlestar Galactica'
		);

		expect(match).not.toBeNull();
		expect(match!.episode.episodeNumber).toBe(20);
		expect(match!.method).toBe('containment');
		expect(match!.position).toBe(0);
	});

	it('matches a TMDB series-prefixed special with the prefix stripped (Pokémon: Mewtwo Returns)', () => {
		const match = matchSpecialEpisodeByTitle(
			pokemonSpecials,
			['Mewtwo Returns (2000)'],
			2000,
			'Pokémon'
		);

		expect(match).not.toBeNull();
		expect(match!.episode.episodeNumber).toBe(13);
		expect(match!.method).toBe('containment');
	});

	it('matches accented episode titles against unaccented filenames', () => {
		const match = matchSpecialEpisodeByTitle(
			pokemonSpecials,
			['The Mastermind of Mirage Pokemon (2006)'],
			2006,
			'Pokémon'
		);

		expect(match).not.toBeNull();
		expect(match!.episode.episodeNumber).toBe(18);
	});

	it('does not match a prefixed special without the series title (coverage too low)', () => {
		// Without the series title the full episode title must be contained;
		// "Mewtwo Returns (2000)" lacks the "Pokémon" prefix and the token
		// subset {mewtwo, returns} only covers 2/3 of the full title's tokens.
		expect(matchSpecialEpisodeByTitle(pokemonSpecials, ['Mewtwo Returns (2000)'], 2000)).toBeNull();
	});

	it('does not match when token coverage is below the floor (The Blue Planet: Seas of Life)', () => {
		const bluePlanetSpecials = [
			{
				seasonNumber: 0,
				episodeNumber: 16,
				title: 'The Blue Planet: Seas of Life',
				airDate: null
			}
		];

		expect(
			matchSpecialEpisodeByTitle(
				bluePlanetSpecials,
				['The Blue Planet (2001)'],
				2001,
				'The Blue Planet'
			)
		).toBeNull();
	});

	it('does not match when season 0 lacks the title (Firefly has no "Serenity" special)', () => {
		const fireflySpecials = [
			{
				seasonNumber: 0,
				episodeNumber: 4,
				title: 'Here’s How It Was: The Making of "Firefly"',
				airDate: '2003-12-09'
			},
			{ seasonNumber: 0, episodeNumber: 9, title: 'Gag Reel', airDate: '2012-11-27' }
		];

		expect(
			matchSpecialEpisodeByTitle(
				fireflySpecials,
				['Serenity [2005]', 'Serenity (2005)'],
				2005,
				'Firefly'
			)
		).toBeNull();
	});

	it('does not match webisode compilation folders against numbered parts', () => {
		expect(
			matchSpecialEpisodeByTitle(
				bsgSpecials,
				[
					'Battlestar.Galactica.The.Face.Of.The.Enemy.Complete.v6.1080p.2ch.subs.x265.HEVC',
					'The Face of the Enemy'
				],
				undefined,
				'Battlestar Galactica'
			)
		).toBeNull();
	});

	it('prefers the longest contained title on position ties', () => {
		const match = matchSpecialEpisodeByTitle(
			bsgSpecials,
			['BSG.S4.The.Journey.Ends.The.Arrival'],
			undefined,
			'Battlestar Galactica'
		);

		expect(match).not.toBeNull();
		expect(match!.episode.episodeNumber).toBe(47);
	});

	it('ignores titles shorter than the containment floor', () => {
		const specials = [{ seasonNumber: 0, episodeNumber: 1, title: 'Oz', airDate: null }];

		expect(matchSpecialEpisodeByTitle(specials, ['Oz (1997)'], 1997)).toBeNull();
	});

	it('returns null when the series has no season 0 episodes', () => {
		const regularOnly = [
			{ seasonNumber: 1, episodeNumber: 1, title: 'Razor', airDate: '2007-11-24' }
		];

		expect(
			matchSpecialEpisodeByTitle(regularOnly, ['Razor (2007)'], 2007, 'Battlestar Galactica')
		).toBeNull();
	});

	it('rejects token-subset matches whose air year disagrees with the parsed year', () => {
		// Word order keeps containment from firing ("returnsofmewtwo" is not
		// a substring of "mewtworeturns1990"), so only the token-subset pass
		// can match — and its year guard must reject a decade-off year.
		const specials = [
			{ seasonNumber: 0, episodeNumber: 1, title: 'Returns of Mewtwo', airDate: '2000-12-30' }
		];

		expect(matchSpecialEpisodeByTitle(specials, ['Mewtwo Returns (1990)'], 1990)).toBeNull();

		const agreeing = matchSpecialEpisodeByTitle(specials, ['Mewtwo Returns (2000)'], 2000);
		expect(agreeing).not.toBeNull();
		expect(agreeing!.method).toBe('tokenSubset');
	});
});

import { describe, it, expect, vi, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieAlternateTitles: vi.fn(),
		getTvAlternateTitles: vi.fn(),
		getMovieTranslations: vi.fn(),
		getTvTranslations: vi.fn()
	}
}));

import {
	cleanTitle,
	selectSearchTitles,
	containsNonLatinScript,
	fetchAndStoreMovieAlternateTitles,
	fetchAndStoreSeriesAlternateTitles,
	storeProviderTitleVariants,
	getMovieSearchTitles,
	getSeriesSearchTitles
} from './AlternateTitleService';
import { tmdb } from '#lib/server/tmdb.js';
import {
	alternateTitles,
	languageProfiles,
	languageSettings,
	movies,
	series
} from '#lib/server/db/schema.js';

const mockedAlternateTitles = tmdb as unknown as {
	getMovieAlternateTitles: ReturnType<typeof vi.fn>;
	getTvAlternateTitles: ReturnType<typeof vi.fn>;
	getMovieTranslations: ReturnType<typeof vi.fn>;
	getTvTranslations: ReturnType<typeof vi.fn>;
};

afterAll(() => {
	destroyTestDb(testDb);
});

function listStoredTitles(mediaId: string) {
	return testDb.db
		.select({
			title: alternateTitles.title,
			source: alternateTitles.source,
			language: alternateTitles.language,
			country: alternateTitles.country
		})
		.from(alternateTitles)
		.where(eq(alternateTitles.mediaId, mediaId))
		.all();
}

describe('cleanTitle', () => {
	describe('Hungarian diacritics (the primary bug fix)', () => {
		it('should strip Hungarian diacritics - Dűne 2', () => {
			expect(cleanTitle('Dűne 2')).toBe('dune 2');
		});

		it('should strip Hungarian diacritics - full title', () => {
			expect(cleanTitle('Dűne: Második rész')).toBe('dune masodik resz');
		});

		it('should handle double acute accent (ű)', () => {
			expect(cleanTitle('Művészet')).toBe('muveszet');
		});

		it('should handle o with double acute (ő)', () => {
			expect(cleanTitle('Szegő')).toBe('szego');
		});
	});

	describe('other Western European diacritics', () => {
		it('should handle German umlauts', () => {
			expect(cleanTitle('Müller')).toBe('muller');
			expect(cleanTitle('Schöne')).toBe('schone');
			expect(cleanTitle('Über')).toBe('uber');
		});

		it('should handle French accented characters', () => {
			expect(cleanTitle('Résumé')).toBe('resume');
			expect(cleanTitle('André')).toBe('andre');
		});

		it('should handle Spanish accented characters', () => {
			expect(cleanTitle('Niño')).toBe('nino');
			expect(cleanTitle('España')).toBe('espana');
			expect(cleanTitle('María')).toBe('maria');
		});
	});

	describe('non-Latin scripts', () => {
		it('should preserve Cyrillic titles for regional tracker searching', () => {
			expect(cleanTitle('Как Деревянко Чехова играл')).toBe('как деревянко чехова играл');
		});

		it('should preserve mixed Latin and Cyrillic titles', () => {
			expect(cleanTitle('How Derevyanko Played / Как Деревянко играл')).toBe(
				'how derevyanko played как деревянко играл'
			);
		});
	});

	describe('basic normalization', () => {
		it('should convert to lowercase', () => {
			expect(cleanTitle('DUNE')).toBe('dune');
			expect(cleanTitle('Movie Title')).toBe('movie title');
		});

		it('should remove "the " prefix when at start', () => {
			expect(cleanTitle('The Matrix')).toBe('matrix');
			expect(cleanTitle('the Dark Knight')).toBe('dark knight');
		});

		it('should replace & with and', () => {
			expect(cleanTitle('Rock & Roll')).toBe('rock and roll');
		});

		it('should remove special quote characters', () => {
			expect(cleanTitle("Rock'n'Roll")).toBe('rocknroll');
			expect(cleanTitle('"Movie Title"')).toBe('movie title');
		});

		it('should replace dots with space', () => {
			expect(cleanTitle('Movie.1999')).toBe('movie 1999');
			expect(cleanTitle('Dune.Part.Two')).toBe('dune part two');
		});

		it('should collapse multiple spaces', () => {
			expect(cleanTitle('Movie    Title')).toBe('movie title');
			expect(cleanTitle('  Movie  ')).toBe('movie');
		});

		it('should trim whitespace', () => {
			expect(cleanTitle('  Movie  ')).toBe('movie');
			expect(cleanTitle('\tMovie\n')).toBe('movie');
		});
	});

	describe('edge cases', () => {
		it('should handle empty string', () => {
			expect(cleanTitle('')).toBe('');
		});

		it('should handle null/undefined gracefully', () => {
			// @ts-expect-error - testing runtime behavior
			expect(cleanTitle(null)).toBe('');
			// @ts-expect-error - testing runtime behavior
			expect(cleanTitle(undefined)).toBe('');
		});

		it('should handle string with only diacritics', () => {
			expect(cleanTitle('ű')).toBe('u');
			expect(cleanTitle('ő')).toBe('o');
		});

		it('should handle numbers', () => {
			expect(cleanTitle('Movie 2')).toBe('movie 2');
			expect(cleanTitle('2024')).toBe('2024');
		});
	});

	describe('real-world movie title examples for nCore/Hungarian matching', () => {
		it('should normalize Dune: Part Two variants for matching', () => {
			expect(cleanTitle('Dune: Part Two')).toBe('dune part two');
			expect(cleanTitle('Dune Part Two')).toBe('dune part two');
			expect(cleanTitle('Dune 2')).toBe('dune 2');
			expect(cleanTitle('Dűne 2')).toBe('dune 2');
			expect(cleanTitle('Dűne: Második rész')).toBe('dune masodik resz');
		});

		it('should allow Hungarian nCore titles to match English search titles', () => {
			const englishSearchTitle = cleanTitle('Dune Part Two');
			const hungarianReleaseTitle = cleanTitle('Dűne 2');
			expect(hungarianReleaseTitle).toBe('dune 2');
			expect(hungarianReleaseTitle).toContain('dune');
			expect(englishSearchTitle).toContain('dune');
		});
	});
});

describe('selectSearchTitles', () => {
	it('keeps a non-Latin alternate when the cap would truncate all of them', () => {
		const remaining = [
			'War Machine',
			'War Machine (2017)',
			'Máquina de Guerra',
			'Военная машина',
			'Máquina de Guerra (España)'
		];
		const titles = selectSearchTitles('War Machine', remaining, 5);
		expect(titles).toHaveLength(5);
		expect(titles).toContain('Военная машина');
		expect(titles[titles.length - 1]).toBe('Военная машина');
	});

	it('does not swap when a non-Latin title is already within the cap', () => {
		const remaining = ['Военная машина', 'Máquina de Guerra', 'Extra 1', 'Extra 2'];
		const titles = selectSearchTitles('War Machine', remaining, 5);
		expect(titles).toEqual([
			'War Machine',
			'Военная машина',
			'Máquina de Guerra',
			'Extra 1',
			'Extra 2'
		]);
	});

	it('returns all titles when under the cap', () => {
		const titles = selectSearchTitles('War Machine', ['Военная машина'], 5);
		expect(titles).toEqual(['War Machine', 'Военная машина']);
	});

	it('does not swap when the display title itself is non-Latin', () => {
		const remaining = ['War Machine', 'Máquina de Guerra', 'Extra 1', 'Extra 2', 'Extra 3'];
		const titles = selectSearchTitles('Военная машина', remaining, 5);
		expect(titles).toHaveLength(5);
		expect(titles[0]).toBe('Военная машина');
		expect(titles).not.toContain('Extra 3');
	});
});

describe('containsNonLatinScript', () => {
	it('detects Cyrillic', () => {
		expect(containsNonLatinScript('Военная машина')).toBe(true);
	});

	it('detects CJK', () => {
		expect(containsNonLatinScript('機動戦士ガンダム')).toBe(true);
	});

	it('rejects plain Latin titles', () => {
		expect(containsNonLatinScript('War Machine')).toBe(false);
		expect(containsNonLatinScript('Máquina de Guerra')).toBe(false);
	});
});

// ===========================================================================
// DB-backed suites: translations storage, provider variants, search titles.
// Uses an in-memory SQLite schema created by createTestDb (fresh DDL already
// carries the extended v139 source CHECK).
// ===========================================================================

describe('fetchAndStoreMovieAlternateTitles (translations)', () => {
	it('stores country rows with null language and translation rows with language, skipping own-title noise', async () => {
		testDb.db
			.insert(movies)
			.values({ id: 'movie-trans-1', tmdbId: 9101, title: 'Dune', path: 'Dune' })
			.run();

		mockedAlternateTitles.getMovieAlternateTitles.mockResolvedValue({
			id: 9101,
			titles: [{ iso_3166_1: 'HU', title: 'Dűne', type: '' }]
		});
		mockedAlternateTitles.getMovieTranslations.mockResolvedValue({
			id: 9101,
			translations: [
				{ iso_639_1: 'hu', iso_3166_1: 'HU', data: { title: 'Dűne: Második rész' } },
				{ iso_639_1: 'ja', iso_3166_1: 'JP', data: { title: 'デューン 砂の惑星' } },
				// Same clean title + language as another translation entry: deduped.
				{ iso_639_1: 'hu', iso_3166_1: 'HU', data: { title: 'Dűne: Második rész ' } },
				// Equals the movie's own display title: skipped as noise.
				{ iso_639_1: 'en', iso_3166_1: 'US', data: { title: 'Dune' } },
				// No title in data: skipped.
				{ iso_639_1: 'fr', iso_3166_1: 'FR', data: {} }
			]
		});

		const inserted = await fetchAndStoreMovieAlternateTitles('movie-trans-1', 9101);

		expect(inserted).toBe(3); // country row + hu translation + ja translation
		const rows = listStoredTitles('movie-trans-1');
		expect(rows).toEqual(
			expect.arrayContaining([
				{ title: 'Dűne', source: 'tmdb', language: null, country: 'HU' },
				{ title: 'Dűne: Második rész', source: 'tmdb', language: 'hu', country: null },
				{ title: 'デューン 砂の惑星', source: 'tmdb', language: 'ja', country: null }
			])
		);
	});

	it('skips translations equal to the original title and dedupes on refetch', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-trans-2',
				tmdbId: 9102,
				title: 'Waqt',
				originalTitle: 'वक्त',
				path: 'Waqt'
			})
			.run();

		mockedAlternateTitles.getMovieAlternateTitles.mockResolvedValue({ id: 9102, titles: [] });
		mockedAlternateTitles.getMovieTranslations.mockResolvedValue({
			id: 9102,
			translations: [
				{ iso_639_1: 'hi', iso_3166_1: 'IN', data: { title: 'वक्त' } }, // original title -> skip
				{ iso_639_1: 'ru', iso_3166_1: 'RU', data: { title: 'Время' } }
			]
		});

		await fetchAndStoreMovieAlternateTitles('movie-trans-2', 9102);
		expect(listStoredTitles('movie-trans-2')).toHaveLength(1);

		// Refetch (e.g. next refresh): no duplicate rows.
		const secondRun = await fetchAndStoreMovieAlternateTitles('movie-trans-2', 9102);
		expect(secondRun).toBe(0);
		expect(listStoredTitles('movie-trans-2')).toHaveLength(1);
	});

	it('keeps country rows when translations fail and vice versa', async () => {
		testDb.db
			.insert(movies)
			.values({ id: 'movie-trans-3', tmdbId: 9103, title: 'Cargo', path: 'Cargo' })
			.run();

		mockedAlternateTitles.getMovieAlternateTitles.mockResolvedValue({
			id: 9103,
			titles: [{ iso_3166_1: 'DE', title: 'Cargo', type: '' }]
		});
		mockedAlternateTitles.getMovieTranslations.mockRejectedValue(new Error('TMDB down'));

		await expect(fetchAndStoreMovieAlternateTitles('movie-trans-3', 9103)).resolves.toBe(1);
		expect(listStoredTitles('movie-trans-3')).toHaveLength(1);

		// Reverse: alternative_titles fails, translations still stored.
		testDb.db
			.insert(movies)
			.values({ id: 'movie-trans-4', tmdbId: 9104, title: 'Cargo II', path: 'Cargo II' })
			.run();
		mockedAlternateTitles.getMovieAlternateTitles.mockRejectedValue(new Error('TMDB down'));
		mockedAlternateTitles.getMovieTranslations.mockResolvedValue({
			id: 9104,
			translations: [{ iso_639_1: 'de', iso_3166_1: 'DE', data: { title: 'Fracht' } }]
		});

		await expect(fetchAndStoreMovieAlternateTitles('movie-trans-4', 9104)).resolves.toBe(1);
		expect(listStoredTitles('movie-trans-4')).toEqual([
			{ title: 'Fracht', source: 'tmdb', language: 'de', country: null }
		]);
	});

	it('stores TV translations from data.name', async () => {
		testDb.db
			.insert(series)
			.values({ id: 'series-trans-1', tmdbId: 9201, title: 'Dark', path: 'Dark' })
			.run();

		mockedAlternateTitles.getTvAlternateTitles.mockResolvedValue({ id: 9201, results: [] });
		mockedAlternateTitles.getTvTranslations.mockResolvedValue({
			id: 9201,
			translations: [
				{ iso_639_1: 'ja', iso_3166_1: 'JP', data: { name: 'ダーク（ドラマ）' } },
				{ iso_639_1: 'en', iso_3166_1: 'US', data: { name: 'Dark' } } // own title -> skip
			]
		});

		const inserted = await fetchAndStoreSeriesAlternateTitles('series-trans-1', 9201);

		expect(inserted).toBe(1);
		expect(listStoredTitles('series-trans-1')).toEqual([
			{ title: 'ダーク（ドラマ）', source: 'tmdb', language: 'ja', country: null }
		]);
	});
});

describe('storeProviderTitleVariants', () => {
	it('inserts anilist variants and is idempotent on re-link/refresh', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 'series-variants-1',
				tmdbId: 9301,
				title: 'Cowboy Bebop',
				path: 'Cowboy Bebop'
			})
			.run();

		const variants = [
			{ title: 'Cowboy Bebop', language: null, country: null },
			{ title: 'カウボーイビバップ', language: null, country: 'JP' }
		];

		await storeProviderTitleVariants('series', 'series-variants-1', 'anilist', variants);
		expect(listStoredTitles('series-variants-1')).toHaveLength(2);

		// Repeat link/refresh stores nothing new.
		await storeProviderTitleVariants('series', 'series-variants-1', 'anilist', variants);
		expect(listStoredTitles('series-variants-1')).toHaveLength(2);

		// The same titles from a different provider are still stored (distinct source).
		await storeProviderTitleVariants('series', 'series-variants-1', 'mal', [
			{ title: 'Cowboy Bebop', language: null, country: null }
		]);
		const rows = listStoredTitles('series-variants-1');
		expect(rows).toHaveLength(3);
		expect(rows.filter((r) => r.source === 'anilist')).toHaveLength(2);
		expect(rows.filter((r) => r.source === 'mal')).toHaveLength(1);
		// No provider supplies language codes; country only where AniList gave one.
		expect(rows.find((r) => r.title === 'カウボーイビバップ')).toMatchObject({
			source: 'anilist',
			language: null,
			country: 'JP'
		});
	});

	it('never writes a language that was not supplied by the provider', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 'series-variants-2',
				tmdbId: 9302,
				title: 'Vinland Saga',
				path: 'Vinland Saga'
			})
			.run();

		await storeProviderTitleVariants('series', 'series-variants-2', 'mal', [
			{ title: 'ヴィンランド・サガ' } // no language/country given at all
		]);

		expect(listStoredTitles('series-variants-2')).toEqual([
			{ title: 'ヴィンランド・サガ', source: 'mal', language: null, country: null }
		]);
	});
});

describe('search titles include provider variants (regression)', () => {
	it('includes anilist/mal variants in movie search titles with CJK ordering preserved', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-search-1',
				tmdbId: 9401,
				title: 'Cowboy Bebop',
				originalTitle: 'カウボーイビバップ',
				path: 'Cowboy Bebop'
			})
			.run();

		// Country-tagged TMDB rows first (en preferred group), then provider
		// variants (country null -> fallback group).
		await testDb.db.insert(alternateTitles).values([
			{
				mediaType: 'movie',
				mediaId: 'movie-search-1',
				title: 'Cowboy Bebop: The Movie',
				cleanTitle: cleanTitle('Cowboy Bebop: The Movie'),
				source: 'tmdb',
				country: 'US'
			},
			{
				mediaType: 'movie',
				mediaId: 'movie-search-1',
				title: 'Kaubōi Bibappu',
				cleanTitle: cleanTitle('Kaubōi Bibappu'),
				source: 'anilist'
			},
			{
				mediaType: 'movie',
				mediaId: 'movie-search-1',
				title: 'カウボーイビバップ 天国の扉',
				cleanTitle: cleanTitle('カウボーイビバップ 天国の扉'),
				source: 'mal'
			},
			{
				mediaType: 'movie',
				mediaId: 'movie-search-1',
				title: 'カウボーイビバップ',
				cleanTitle: cleanTitle('カウボーイビバップ'),
				source: 'tmdb',
				country: 'JP'
			}
		]);

		const titles = await getMovieSearchTitles('movie-search-1', 'en');

		// Display title first.
		expect(titles[0]).toBe('Cowboy Bebop');
		// Every variant survives the cap (list stays under it anyway).
		expect(titles).toContain('Cowboy Bebop: The Movie');
		expect(titles).toContain('Kaubōi Bibappu');
		expect(titles).toContain('カウボーイビバップ 天国の扉');
		expect(titles).toContain('カウボーイビバップ');
		// CJK ordering still applies: Latin-script titles before CJK-script ones.
		const firstCjkIndex = titles.findIndex((t) => containsNonLatinScript(t));
		const lastLatinIndex = titles.findLastIndex((t) => !containsNonLatinScript(t));
		expect(lastLatinIndex).toBeLessThan(firstCjkIndex);
		// Original title (same text as the JP tmdb row) appears exactly once.
		expect(titles.filter((t) => t === 'カウボーイビバップ')).toHaveLength(1);
	});

	it('includes anilist/mal variants in series search titles', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 'series-search-1',
				tmdbId: 9402,
				title: 'Vinland Saga',
				path: 'Vinland Saga',
				originalTitle: 'ヴィンランド・サガ'
			})
			.run();

		await testDb.db.insert(alternateTitles).values([
			{
				mediaType: 'series',
				mediaId: 'series-search-1',
				title: 'Vinland Saga Season 2',
				cleanTitle: cleanTitle('Vinland Saga Season 2'),
				source: 'anilist'
			},
			{
				mediaType: 'series',
				mediaId: 'series-search-1',
				title: 'ヴィンランド・サガ II',
				cleanTitle: cleanTitle('ヴィンランド・サガ II'),
				source: 'mal'
			}
		]);

		const titles = await getSeriesSearchTitles('series-search-1', 'en');

		expect(titles[0]).toBe('Vinland Saga');
		expect(titles).toContain('Vinland Saga Season 2');
		expect(titles).toContain('ヴィンランド・サガ II');
	});
});

describe('search titles following the language profile', () => {
	const ITALIAN_FIRST = 'profile-italian-first';
	const ENGLISH_FIRST = 'profile-english-first';
	const ORIGINAL_FIRST = 'profile-original-first';

	testDb.db
		.insert(languageSettings)
		.values({ id: 'singleton', metadataLocale: 'it-IT', region: 'IT' })
		.onConflictDoUpdate({
			target: languageSettings.id,
			set: { metadataLocale: 'it-IT', region: 'IT' }
		})
		.run();
	testDb.db
		.insert(languageProfiles)
		.values([
			{
				id: ITALIAN_FIRST,
				name: 'Italian, then English',
				audio: { preferOriginal: false, languages: ['it', 'en'], mode: 'prefer' },
				subtitles: [{ tag: 'it', variant: 'regular', accessibility: 'any' }]
			},
			{
				id: ENGLISH_FIRST,
				name: 'English, then Italian',
				audio: { preferOriginal: false, languages: ['en', 'it'], mode: 'prefer' },
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }]
			},
			{
				id: ORIGINAL_FIRST,
				name: 'Original, then Italian',
				audio: { preferOriginal: true, languages: ['it'], mode: 'prefer' },
				subtitles: [{ tag: 'it', variant: 'regular', accessibility: 'any' }]
			}
		])
		.run();

	function insertHangover(id: string, tmdbId: number, languageProfileId: string | null) {
		testDb.db
			.insert(movies)
			.values({
				id,
				tmdbId,
				title: 'Una notte da leoni',
				originalTitle: 'The Hangover',
				originalLanguage: 'en',
				path: id,
				languageProfileId
			})
			.run();
	}

	it('keeps the display title first without a language profile', async () => {
		insertHangover('movie-no-profile', 18785, null);

		const titles = await getMovieSearchTitles('movie-no-profile', 'it');

		expect(titles.slice(0, 2)).toEqual(['Una notte da leoni', 'The Hangover']);
	});

	it('searches the Italian title first for an Italian-first profile', async () => {
		insertHangover('movie-italian-first', 18786, ITALIAN_FIRST);

		const titles = await getMovieSearchTitles('movie-italian-first', 'it');

		expect(titles.slice(0, 2)).toEqual(['Una notte da leoni', 'The Hangover']);
	});

	it('searches the English title first for an English-first profile', async () => {
		insertHangover('movie-english-first', 18787, ENGLISH_FIRST);

		const titles = await getMovieSearchTitles('movie-english-first', 'it');

		expect(titles.slice(0, 2)).toEqual(['The Hangover', 'Una notte da leoni']);
	});

	it('searches the original title first when the profile prefers original audio', async () => {
		insertHangover('movie-original-first', 18788, ORIGINAL_FIRST);

		const titles = await getMovieSearchTitles('movie-original-first', 'it');

		expect(titles.slice(0, 2)).toEqual(['The Hangover', 'Una notte da leoni']);
	});

	it('uses a stored translation for a language that is neither original nor display', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-translation',
				tmdbId: 129,
				title: 'La città incantata',
				originalTitle: '千と千尋の神隠し',
				originalLanguage: 'ja',
				path: 'movie-translation',
				languageProfileId: ENGLISH_FIRST
			})
			.run();
		await testDb.db.insert(alternateTitles).values({
			mediaType: 'movie',
			mediaId: 'movie-translation',
			title: 'Spirited Away',
			cleanTitle: cleanTitle('Spirited Away'),
			source: 'tmdb',
			language: 'en'
		});

		const titles = await getMovieSearchTitles('movie-translation', 'it');

		expect(titles.slice(0, 2)).toEqual(['Spirited Away', 'La città incantata']);
	});

	it('keeps a non-Latin original title out of the first slot', async () => {
		testDb.db
			.insert(movies)
			.values({
				id: 'movie-original-cjk',
				tmdbId: 130,
				title: 'La città incantata',
				originalTitle: '千と千尋の神隠し',
				originalLanguage: 'ja',
				path: 'movie-original-cjk',
				languageProfileId: ORIGINAL_FIRST
			})
			.run();

		const titles = await getMovieSearchTitles('movie-original-cjk', 'it');

		expect(titles[0]).toBe('La città incantata');
		expect(titles).toContain('千と千尋の神隠し');
	});

	it('applies to series too', async () => {
		testDb.db
			.insert(series)
			.values({
				id: 'series-english-first',
				tmdbId: 1399,
				title: 'Il trono di spade',
				originalTitle: 'Game of Thrones',
				originalLanguage: 'en',
				path: 'series-english-first',
				languageProfileId: ENGLISH_FIRST
			})
			.run();

		const titles = await getSeriesSearchTitles('series-english-first', 'it');

		expect(titles.slice(0, 2)).toEqual(['Game of Thrones', 'Il trono di spade']);
	});
});

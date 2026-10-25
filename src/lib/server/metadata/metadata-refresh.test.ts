import { describe, it, expect, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';
import { isGeneratedEpisodeTitle } from './episode-title.js';

const testDb = createTestDb();

const fetchCalls: string[] = [];

// original_language the mock TMDB serves per tv id (details + probe endpoints)
const seriesOriginalByTmdbId: Record<number, string> = {
	4242: 'ja',
	5555: 'ko',
	6666: 'it',
	7777: 'ko'
};

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
		fetch: vi.fn(async (url: string) => {
			fetchCalls.push(url);

			const seriesDetails = url.match(/^\/tv\/(\d+)\?/);
			if (seriesDetails) {
				const id = Number(seriesDetails[1]);
				return {
					name: `Series ${id}`,
					original_name: `Original Series ${id}`,
					original_language: seriesOriginalByTmdbId[id] ?? 'en',
					overview: 'Series overview.',
					first_air_date: '2020-01-01'
				};
			}

			// Bare tv endpoint = original-language probe
			const seriesProbe = url.match(/^\/tv\/(\d+)$/);
			if (seriesProbe) {
				return { original_language: seriesOriginalByTmdbId[Number(seriesProbe[1])] ?? 'en' };
			}

			if (/^\/movie\/\d+\?/.test(url)) {
				return {
					title: 'Mock Movie',
					original_title: 'Original Mock Movie',
					original_language: 'fr',
					overview: 'Movie overview.',
					release_date: '2021-05-21',
					runtime: 100,
					genres: [{ id: 1, name: 'Drama' }]
				};
			}

			if (/\/episode\/4\?/.test(url)) {
				// Localized (German) response carries only a TMDB-generated name.
				return { name: 'Folge 4', overview: '' };
			}
			if (/\/episode\/4$/.test(url)) {
				return { name: 'The Real Title', overview: 'Real overview.' };
			}
			if (/\/episode\/5\?/.test(url)) {
				// Localized response with a real translation.
				return {
					name: 'Die echte Übersetzung',
					overview: 'Echte Beschreibung.',
					air_date: '2026-03-10',
					runtime: 42
				};
			}
			if (/\/episode\/7\?/.test(url)) {
				return { name: 'Folge 7', overview: '' };
			}
			if (/\/episode\/8\?language=ko$/.test(url)) {
				// Original-language (ko) fallback response with the real title.
				return { name: 'Real Eight', overview: 'Real eight overview.' };
			}
			if (/\/episode\/8\?/.test(url)) {
				return { name: 'Folge 8', overview: '' };
			}
			if (/\/episode\/8$/.test(url)) {
				return { name: 'Real Eight Unlocalized', overview: 'Real eight overview.' };
			}
			if (/\/episode\/\d+$/.test(url)) {
				return { name: 'The Real Title', overview: 'Real overview.' };
			}
			return {};
		})
	}
}));

const {
	refreshMovieMetadata,
	refreshSeriesMetadata,
	resolveLanguage,
	resolveLanguageForFetch,
	metadataLanguageToLegacy
} = await import('./metadata-refresh.js');
const { tmdb } = await import('#lib/server/tmdb.js');
const mockFetch = tmdb.fetch as unknown as ReturnType<typeof vi.fn>;
const { movies, series, episodes } = await import('#lib/server/db/schema.js');

testDb.db
	.insert(series)
	.values({
		id: 'series-1',
		tmdbId: 4242,
		title: 'Test Series',
		path: 'Test Series',
		metadataLanguageMode: 'explicit',
		metadataLanguageValue: 'de'
	})
	.run();

// mode 'original' with a persisted original language: no probe may happen
testDb.db
	.insert(series)
	.values({
		id: 'series-2',
		tmdbId: 5555,
		title: 'Persisted Original Series',
		path: 'Persisted Original Series',
		metadataLanguageMode: 'original',
		originalLanguage: 'ko'
	})
	.run();

// mode 'original' without a persisted original language: probe + lazy write-back
testDb.db
	.insert(series)
	.values({
		id: 'series-3',
		tmdbId: 6666,
		title: 'Probe Series',
		path: 'Probe Series',
		metadataLanguageMode: 'original'
	})
	.run();

// explicit German locale with a persisted Korean original: episode fallback
// must refetch with language=ko
testDb.db
	.insert(series)
	.values({
		id: 'series-4',
		tmdbId: 7777,
		title: 'Localized Series',
		path: 'Localized Series',
		metadataLanguageMode: 'explicit',
		metadataLanguageValue: 'de',
		originalLanguage: 'ko'
	})
	.run();

testDb.db
	.insert(episodes)
	.values([
		{
			id: 'episode-1',
			seriesId: 'series-1',
			seasonNumber: 2,
			episodeNumber: 4,
			title: 'The Real Title',
			overview: 'Existing overview.'
		},
		{
			id: 'episode-2',
			seriesId: 'series-1',
			seasonNumber: 2,
			episodeNumber: 5,
			title: 'Old Title',
			overview: null
		},
		{
			id: 'episode-3',
			seriesId: 'series-2',
			seasonNumber: 3,
			episodeNumber: 7,
			title: 'Original Episode Title',
			overview: null
		},
		{
			id: 'episode-4',
			seriesId: 'series-4',
			seasonNumber: 1,
			episodeNumber: 8,
			title: 'Old Localized Title',
			overview: null
		}
	])
	.run();

testDb.db
	.insert(movies)
	.values({
		id: 'movie-1',
		tmdbId: 111,
		title: 'Old Movie Title',
		path: 'Old Movie Title'
	})
	.run();

afterAll(() => {
	destroyTestDb(testDb);
});

async function getEpisode(id: string) {
	const [row] = await testDb.db.select().from(episodes).where(eq(episodes.id, id));
	return row;
}

async function getSeriesRow(id: string) {
	const [row] = await testDb.db.select().from(series).where(eq(series.id, id));
	return row;
}

async function getMovieRow(id: string) {
	const [row] = await testDb.db.select().from(movies).where(eq(movies.id, id));
	return row;
}

describe('isGeneratedEpisodeTitle', () => {
	it('flags TMDB-generated placeholder names across languages', () => {
		expect(isGeneratedEpisodeTitle('Folge 12')).toBe(true);
		expect(isGeneratedEpisodeTitle('Episode 8')).toBe(true);
		expect(isGeneratedEpisodeTitle('Épisode 3')).toBe(true);
		expect(isGeneratedEpisodeTitle('Episodio 21')).toBe(true);
		expect(isGeneratedEpisodeTitle('Episódio 5')).toBe(true);
		expect(isGeneratedEpisodeTitle('Odcinek 7')).toBe(true);
		expect(isGeneratedEpisodeTitle('Эпизод 9')).toBe(true);
		expect(isGeneratedEpisodeTitle('Bölüm 14')).toBe(true);
		expect(isGeneratedEpisodeTitle('第8話')).toBe(true);
	});

	it('accepts real titles, including ones containing template words', () => {
		expect(isGeneratedEpisodeTitle('The Real Title')).toBe(false);
		expect(isGeneratedEpisodeTitle('Folgen und Folgen')).toBe(false);
		expect(isGeneratedEpisodeTitle('')).toBe(true);
	});
});

describe('refreshSeriesMetadata placeholder protection', () => {
	it('does not overwrite a real title with a generated localized name and falls back to the original-language title', async () => {
		await refreshSeriesMetadata('series-1');

		const row = await getEpisode('episode-1');
		expect(row.title).toBe('The Real Title');

		// The series' original language is unknown (null), so a non-localized
		// request must have been made as the fallback source.
		expect(fetchCalls.some((url) => /\/episode\/4$/.test(url))).toBe(true);
	});

	it('still stores genuine translations', async () => {
		await refreshSeriesMetadata('series-1');

		const row = await getEpisode('episode-2');
		expect(row.title).toBe('Die echte Übersetzung');
		expect(row.overview).toBe('Echte Beschreibung.');
	});

	it('refreshes a stale air date and runtime unconditionally, not just on first backfill', async () => {
		// Simulate a date TMDB later confirmed/shifted after the episode row
		// already had a title (so the title-fallback path above wouldn't touch
		// it) — this must still get corrected on every refresh, not just once.
		await testDb.db
			.update(episodes)
			.set({ airDate: '2025-01-01', runtime: 30 })
			.where(eq(episodes.id, 'episode-2'));

		await refreshSeriesMetadata('series-1');

		const after = await getEpisode('episode-2');
		expect(after.airDate).toBe('2026-03-10');
		expect(after.runtime).toBe(42);
	});
});

describe('original_language persistence', () => {
	it('refreshSeriesMetadata writes original_language from the TMDB response', async () => {
		await refreshSeriesMetadata('series-1');

		const row = await getSeriesRow('series-1');
		expect(row.originalLanguage).toBe('ja');
	});

	it('refreshMovieMetadata writes original_language from the TMDB response', async () => {
		await refreshMovieMetadata('movie-1');

		const row = await getMovieRow('movie-1');
		expect(row.originalLanguage).toBe('fr');
		expect(row.title).toBe('Mock Movie');
	});

	it('does not probe TMDB when mode is original and the original language is persisted', async () => {
		fetchCalls.length = 0;
		await refreshSeriesMetadata('series-2');

		// No bare /tv/5555 probe request; the details request uses the persisted language.
		expect(fetchCalls.some((url) => url === '/tv/5555')).toBe(false);
		const detailsCall = fetchCalls.find((url) => url.startsWith('/tv/5555?'));
		expect(detailsCall).toBeDefined();
		expect(new URLSearchParams(detailsCall!.split('?')[1]).get('language')).toBe('ko');

		// Primary request already used the original language: no redundant fallback fetch.
		expect(fetchCalls.some((url) => /\/episode\/7$/.test(url))).toBe(false);
	});

	it('probes TMDB when mode is original and the persisted value is null, then writes it back', async () => {
		fetchCalls.length = 0;
		await refreshSeriesMetadata('series-3');

		// Probe hit the bare endpoint exactly once.
		expect(fetchCalls.filter((url) => url === '/tv/6666')).toHaveLength(1);

		// Lazy backfill: the probed value is persisted on the row.
		const row = await getSeriesRow('series-3');
		expect(row.originalLanguage).toBe('it');

		// The details fetch used the probed language.
		const detailsCall = fetchCalls.find((url) => url.startsWith('/tv/6666?'));
		expect(detailsCall).toBeDefined();
		expect(new URLSearchParams(detailsCall!.split('?')[1]).get('language')).toBe('it');
	});
});

describe('episode fallback uses the series original language', () => {
	it('refetches with language=<series original_language> when the localized name is generated', async () => {
		fetchCalls.length = 0;
		await refreshSeriesMetadata('series-4');

		const fallbackCall = fetchCalls.find(
			(url) => url === '/tv/7777/season/1/episode/8?language=ko'
		);
		expect(fallbackCall).toBeDefined();

		const row = await getEpisode('episode-4');
		expect(row.title).toBe('Real Eight');
		expect(row.overview).toBe('Real eight overview.');
	});
});

describe('URLSearchParams request building', () => {
	it('builds encoded, parseable detail requests without manual interpolation', async () => {
		fetchCalls.length = 0;
		await refreshSeriesMetadata('series-1');

		const detailsCall = fetchCalls.find((url) => url.startsWith('/tv/4242?'));
		expect(detailsCall).toBeDefined();

		// Encoded exactly once: a single "?", no raw commas/slashes breaking params.
		expect(detailsCall!.match(/\?/g)).toHaveLength(1);
		expect(detailsCall).toContain(
			'append_to_response=credits%2Cvideos%2Cimages%2Crecommendations%2Csimilar%2Cwatch%2Fproviders%2Ccontent_ratings%2Ckeywords'
		);
		expect(detailsCall).not.toContain(' ');

		const query = new URLSearchParams(detailsCall!.split('?')[1]);
		// include_image_language is injected by tmdb.fetch from the effective
		// language, not hardcoded here.
		expect([...query.keys()].sort()).toEqual(['append_to_response', 'language']);
		expect(query.get('append_to_response')).toBe(
			'credits,videos,images,recommendations,similar,watch/providers,content_ratings,keywords'
		);
		expect(query.get('language')).toBe('de');
	});

	it('builds episode requests with an encoded language param', async () => {
		fetchCalls.length = 0;
		await refreshSeriesMetadata('series-1');

		const localizedCall = fetchCalls.find((url) => url.startsWith('/tv/4242/season/2/episode/4?'));
		expect(localizedCall).toBe('/tv/4242/season/2/episode/4?language=de');
	});
});

describe('metadata language pair resolution', () => {
	it('resolveLanguageForFetch uses the explicit value', () => {
		expect(resolveLanguageForFetch('explicit', 'de', 'ja')).toBe('de');
	});

	it('resolveLanguageForFetch falls back to the original language', () => {
		expect(resolveLanguageForFetch('original', null, 'ja')).toBe('ja');
	});

	it('resolveLanguageForFetch returns null for inherit/null', () => {
		expect(resolveLanguageForFetch('inherit', 'de', 'ja')).toBeNull();
		expect(resolveLanguageForFetch(null, 'de', 'ja')).toBeNull();
		expect(resolveLanguageForFetch(undefined, undefined, 'ja')).toBeNull();
	});

	it('resolveLanguage uses the persisted original language without fetching', async () => {
		const callsBefore = fetchCalls.length;
		await expect(
			resolveLanguage('original', null, '/tv/5555', { originalLanguage: 'ko' })
		).resolves.toBe('ko');
		expect(fetchCalls.length).toBe(callsBefore);
	});

	it('resolveLanguage probes and reports the original language when it is unknown', async () => {
		let probed: string | null = null;
		await expect(
			resolveLanguage('original', null, '/tv/6666', {
				onProbed: async (lang) => {
					probed = lang;
				}
			})
		).resolves.toBe('it');
		expect(probed).toBe('it');
		expect(fetchCalls).toContain('/tv/6666');
	});

	it('resolveLanguage returns null when the probe fails', async () => {
		mockFetch.mockRejectedValueOnce(new Error('network down'));
		await expect(resolveLanguage('original', null, '/tv/9999', {})).resolves.toBeNull();
	});

	it('metadataLanguageToLegacy derives the legacy view from the pair', () => {
		expect(metadataLanguageToLegacy('explicit', 'de')).toBe('de');
		expect(metadataLanguageToLegacy('original', null)).toBe('original');
		expect(metadataLanguageToLegacy('inherit', null)).toBeNull();
		expect(metadataLanguageToLegacy(null, null)).toBeNull();
	});
});

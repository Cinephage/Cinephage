import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal db mock: loadTmdbSettings reads tmdb_api_key/global_filters from
// settings and the language_settings singleton. A bare key keeps the fetch
// path free of filter injection; the network layer is stubbed below.
vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			settings: {
				findFirst: vi.fn(async () => ({ value: 'test-api-key' }))
			},
			languageSettings: {
				findFirst: vi.fn(async () => undefined)
			}
		}
	}
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { tmdb } = await import('./tmdb.js');

function okJson(payload: unknown) {
	return { ok: true, json: async () => payload };
}

describe('tmdb translations endpoints', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		tmdb.invalidateSettings();
	});

	it('getMovieTranslations hits /movie/{id}/translations and returns the payload', async () => {
		const payload = {
			id: 550,
			translations: [
				{
					iso_639_1: 'hu',
					iso_3166_1: 'HU',
					name: 'Magyar',
					english_name: 'Hungarian',
					data: { title: 'Harcos klub', overview: 'Leírás' }
				}
			]
		};
		fetchMock.mockResolvedValue(okJson(payload));

		const result = await tmdb.getMovieTranslations(550);

		expect(result).toEqual(payload);
		const requestedUrl = String(fetchMock.mock.calls[0][0]);
		const path = new URL(requestedUrl).pathname;
		expect(path).toBe('/3/movie/550/translations');
	});

	it('getTvTranslations hits /tv/{id}/translations', async () => {
		const payload = {
			id: 1396,
			translations: [
				{
					iso_639_1: 'ja',
					iso_3166_1: 'JP',
					name: '日本語',
					english_name: 'Japanese',
					data: { name: 'ブレイキング・バッド', overview: '説明' }
				}
			]
		};
		fetchMock.mockResolvedValue(okJson(payload));

		const result = await tmdb.getTvTranslations(1396);

		expect(result).toEqual(payload);
		const path = new URL(String(fetchMock.mock.calls[0][0])).pathname;
		expect(path).toBe('/3/tv/1396/translations');
	});
});

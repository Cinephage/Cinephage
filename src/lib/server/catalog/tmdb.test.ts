import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		isConfigured: vi.fn(async () => true),
		fetch: vi.fn()
	}
}));

import { tmdb } from '#lib/server/tmdb.js';
import { legacyRows, tmdbCatalogSource } from './tmdb.js';
import { catalogSource, catalogSourceForKind } from './registry.js';

const fetchMock = vi.mocked(tmdb.fetch);
const page = (rows: Record<string, unknown>[]) => ({
	results: rows,
	page: 1,
	total_pages: 3,
	total_results: 60
});

describe('tmdb catalog source', () => {
	it('serves movie and tv, and no other kind', () => {
		expect(tmdbCatalogSource.kinds).toEqual(['movie', 'tv']);
		expect(catalogSourceForKind('movie')).toBe(tmdbCatalogSource);
		expect(catalogSourceForKind('tv')).toBe(tmdbCatalogSource);
	});

	it('finds the source by id', () => {
		expect(catalogSource('tmdb')).toBe(tmdbCatalogSource);
		expect(catalogSource('musicbrainz')).toBeUndefined();
	});

	it('maps top-rated movies to catalog items and back to legacy rows', async () => {
		fetchMock.mockResolvedValueOnce(
			page([{ id: 27205, title: 'Inception', release_date: '2010-07-16', vote_average: 8.4 }])
		);
		const result = await tmdbCatalogSource.discover({ type: 'movie', page: 1, topRated: 'true' });
		expect(result?.items).toHaveLength(1);
		const item = result!.items[0];
		expect(item.kind).toBe('movie');
		expect(item.id).toBe('27205');
		expect(item.title).toBe('Inception');
		expect(item.year).toBe(2010);

		const [row] = legacyRows(result!.items);
		expect(row.id).toBe(27205);
		expect(row.media_type).toBe('movie');
		expect(row.vote_average).toBe(8.4);
	});

	it('stamps tv rows with their kind on the combined top-rated path', async () => {
		fetchMock.mockResolvedValueOnce(page([{ id: 27205, title: 'Inception', release_date: '2010-07-16' }]));
		fetchMock.mockResolvedValueOnce(page([{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }]));
		const result = await tmdbCatalogSource.discover({ type: 'all', page: 1, topRated: 'true' });
		const kinds = result!.items.map((i) => i.kind).sort();
		expect(kinds).toEqual(['movie', 'tv']);
		const tv = result!.items.find((i) => i.id === '1396');
		expect(tv?.year).toBe(2008);
	});
});

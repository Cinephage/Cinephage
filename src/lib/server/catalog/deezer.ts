/**
 * The music catalog source: Deezer charts, one page at a time.
 *
 * Deezer guides ~50 requests per 5 s; the client in `deezerApi.ts` caches a
 * chart for an hour, so Discover holds at most a page of chart rows — the
 * standing rule for a source whose ToS cannot be verified: TTL-cached
 * enrichment, never a mirrored catalog.
 */

import {
	createDeezerApi,
	pickImage,
	type DeezerAlbum,
	type DeezerApi,
	type DeezerApiOptions
} from './deezerApi.js';
import type { CatalogItem, CatalogPage, CatalogSource } from './types.js';

const ROWS_PER_PAGE = 24;
const CHART_FETCH_ROWS = 100;
const CHART_PAGES_CAP = 4;

export interface DeezerChartOptions extends DeezerApiOptions {
	api?: DeezerApi;
}

/** The row shape the Discover surfaces return for music today. */
export function musicLegacyRows(items: CatalogItem[]): Record<string, unknown>[] {
	return items.map((item) => ({
		...(item.meta ?? {}),
		id: item.id,
		title: item.title,
		subtitle: item.subtitle ?? null,
		image_url: item.imageUrl ?? null,
		media_type: 'music',
		// A chart row is an album, and it carries the Deezer id its page needs.
		mbid: null,
		musicKind: (item.meta?.musicKind as string | undefined) ?? 'album',
		album_title: item.title,
		deezerId: (item.meta?.deezerId as number | undefined) ?? Number(item.id)
	}));
}

/** One chart album as a catalog item — shared by the grid and the landing shelves. */
export function chartAlbumItem(album: DeezerAlbum): CatalogItem {
	return {
		kind: 'music',
		id: String(album.id),
		title: album.title,
		subtitle: album.artist?.name,
		year: album.release_date ? Number(album.release_date.slice(0, 4)) || null : null,
		imageUrl: pickImage(album.cover_big, album.cover_medium),
		meta: {
			deezerId: album.id,
			deezerAlbumId: album.id,
			artistName: album.artist?.name ?? null,
			musicKind: 'album'
		}
	};
}

export function createDeezerChartSource(options: DeezerChartOptions = {}): CatalogSource {
	const api = options.api ?? createDeezerApi(options);

	return {
		id: 'deezer',
		kinds: ['music'],
		facets: [],
		async discover(raw): Promise<CatalogPage | null> {
			const params = raw as { page?: number; genre?: number | string };
			const page = Math.max(1, Number(params.page ?? 1));
			const genreId = params.genre ? Number(params.genre) || undefined : undefined;
			const { rows, total } = await api.chartAlbums(genreId, CHART_FETCH_ROWS);
			if (rows.length === 0) return null;
			const start = (page - 1) * ROWS_PER_PAGE;
			const items = rows.slice(start, start + ROWS_PER_PAGE).map(chartAlbumItem);
			return {
				items,
				pagination: {
					page,
					total_pages: Math.min(
						CHART_PAGES_CAP,
						Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE))
					),
					total_results: total
				}
			};
		}
	};
}

export const deezerChartSource = createDeezerChartSource();

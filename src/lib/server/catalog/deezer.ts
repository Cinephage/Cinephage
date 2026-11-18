import type { CatalogItem, CatalogPage, CatalogSource } from './types.js';

const CHART_URL = 'https://api.deezer.com/chart/0/albums';
const ROWS_PER_PAGE = 24;
// Deezer guides ~50 requests per 5 s; one chart fetch an hour stays far inside
// it, and the cache means Discover holds at most a page of chart rows — the
// standing rule for a source whose ToS cannot be verified: TTL-cached
// enrichment, never a mirrored catalog.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CHART_FETCH_ROWS = 100;
const CHART_PAGES_CAP = 4;

interface DeezerChartAlbum {
	id: number;
	title: string;
	cover_big?: string;
	artist?: { name?: string };
}

interface ChartCache {
	at: number;
	rows: DeezerChartAlbum[];
	total: number;
}

export interface DeezerChartOptions {
	fetchImpl?: typeof fetch;
	/** Injectable clock, for tests. */
	now?: () => number;
}

/** The row shape the Discover surfaces return for music today. */
export function musicLegacyRows(items: CatalogItem[]): Record<string, unknown>[] {
	return items.map((item) => ({
		...(item.meta ?? {}),
		id: item.id,
		title: item.title,
		subtitle: item.subtitle ?? null,
		image_url: item.imageUrl ?? null,
		media_type: 'music'
	}));
}

export function createDeezerChartSource(options: DeezerChartOptions = {}): CatalogSource {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	let cache: ChartCache | null = null;

	async function chart(): Promise<ChartCache | null> {
		if (cache && now() - cache.at < CACHE_TTL_MS) return cache;
		try {
			const response = await fetchImpl(`${CHART_URL}?limit=${CHART_FETCH_ROWS}`, {
				headers: { accept: 'application/json' }
			});
			if (!response.ok) return cache;
			const body = (await response.json()) as { data?: DeezerChartAlbum[]; total?: number };
			if (!Array.isArray(body.data)) return cache;
			cache = { at: now(), rows: body.data, total: body.total ?? body.data.length };
			return cache;
		} catch {
			// A dead upstream keeps the last good page until it expires.
			return cache;
		}
	}

	return {
		id: 'deezer',
		kinds: ['music'],
		facets: [],
		async discover(raw): Promise<CatalogPage | null> {
			const params = raw as { page?: number };
			const page = Math.max(1, Number(params.page ?? 1));
			const snapshot = await chart();
			if (!snapshot) return null;
			const start = (page - 1) * ROWS_PER_PAGE;
			const rows = snapshot.rows.slice(start, start + ROWS_PER_PAGE);
			const items: CatalogItem[] = rows.map((row) => ({
				kind: 'music',
				id: String(row.id),
				title: row.title,
				subtitle: row.artist?.name,
				imageUrl: row.cover_big ?? null,
				meta: { deezerId: row.id, artistName: row.artist?.name ?? null }
			}));
			return {
				items,
				pagination: {
					page,
					total_pages: Math.min(
						CHART_PAGES_CAP,
						Math.max(1, Math.ceil(snapshot.rows.length / ROWS_PER_PAGE))
					),
					total_results: snapshot.total
				}
			};
		}
	};
}

export const deezerChartSource = createDeezerChartSource();

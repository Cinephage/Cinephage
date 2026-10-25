import type {
	MetadataDetails,
	MetadataMediaType,
	MetadataProvider,
	MetadataSearchResult,
	MetadataTitleVariant
} from './types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MalProvider', logDomain: 'system' });

// Jikan v4 shapes (unofficial MAL mirror, no auth required)
interface JikanTitle {
	type: string;
	title: string;
}

interface JikanImage {
	jpg?: { large_image_url?: string | null };
}

interface JikanGenre {
	name: string;
}

interface JikanStudio {
	name: string;
}

interface JikanAired {
	from?: string | null;
	prop?: { from?: { year?: number | null } };
}

interface JikanAnime {
	mal_id: number;
	title: string;
	title_english?: string | null;
	title_japanese?: string | null;
	titles?: JikanTitle[];
	images?: JikanImage;
	synopsis?: string | null;
	year?: number | null;
	aired?: JikanAired;
	genres?: JikanGenre[];
	explicit_genres?: JikanGenre[];
	studios?: JikanStudio[];
	status?: string | null;
	rating?: string | null;
}

interface JikanSearchResponse {
	data?: JikanAnime[];
}

interface JikanDetailsResponse {
	data?: JikanAnime;
}

// Jikan enforces ~3 req/s; track last request time and throttle if needed.
let lastRequestAt = 0;
const JIKAN_MIN_INTERVAL_MS = 350;

async function jikanFetch(url: string): Promise<Response> {
	const now = Date.now();
	const wait = JIKAN_MIN_INTERVAL_MS - (now - lastRequestAt);
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastRequestAt = Date.now();
	// Without this, a stalled Jikan response blocks the caller indefinitely,
	// resolveAnimeProviderRef awaits this per query variant directly on the
	// series page's SSR critical path (see resolveMissingAnimeProviderRefs),
	// so an unresponsive upstream here previously meant an unbounded page-load
	// stall.
	return fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
}

function mapStatus(status?: string | null): string | undefined {
	switch (status) {
		case 'Finished Airing':
			return 'Ended';
		case 'Currently Airing':
			return 'Returning Series';
		case 'Not yet aired':
			return 'Planned';
		default:
			return undefined;
	}
}

function extractYear(anime: JikanAnime): number | null {
	if (anime.year) return anime.year;
	if (anime.aired?.prop?.from?.year) return anime.aired.prop.from.year;
	if (anime.aired?.from) {
		const y = Number.parseInt(anime.aired.from.slice(0, 4), 10);
		return Number.isFinite(y) ? y : null;
	}
	return null;
}

function isHentai(anime: JikanAnime): boolean {
	if (anime.rating === 'Rx - Hentai') return true;
	const explicitNames = (anime.explicit_genres ?? []).map((g) => g.name.toLowerCase());
	return explicitNames.includes('hentai') || explicitNames.includes('erotica');
}

function collectGenres(anime: JikanAnime): string[] {
	const names = new Set<string>();
	for (const g of anime.genres ?? []) names.add(g.name);
	for (const g of anime.explicit_genres ?? []) names.add(g.name);
	return [...names];
}

/**
 * Expose every title variant Jikan/MAL reports (english, japanese, the
 * titles[] list) instead of discarding them. Jikan supplies no language or
 * country codes — its type labels ('Japanese', 'English', 'Synonym', …) are
 * kind annotations, not ISO codes — so `language`/`country` stay null and are
 * never guessed.
 */
function buildTitleVariants(anime: JikanAnime): MetadataTitleVariant[] {
	const variants: MetadataTitleVariant[] = [];
	const seen = new Set<string>();

	const push = (title?: string | null) => {
		const trimmed = title?.trim();
		if (!trimmed) return;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		variants.push({ title: trimmed, language: null, country: null });
	};

	push(anime.title_english);
	push(anime.title_japanese);
	for (const entry of anime.titles ?? []) push(entry.title);

	return variants;
}

export class MalProvider implements MetadataProvider {
	readonly id = 'mal' as const;
	readonly name = 'MyAnimeList (Jikan)';
	readonly description = 'Jikan v4 - unofficial public MAL mirror, no authentication required.';

	constructor(private readonly enabled: boolean) {}

	isConfigured(): boolean {
		return this.enabled;
	}

	async searchTitle(query: string, _type: MetadataMediaType): Promise<MetadataSearchResult[]> {
		if (!this.enabled || !query.trim()) return [];

		const url = new URL('https://api.jikan.moe/v4/anime');
		url.searchParams.set('q', query.trim());
		url.searchParams.set('limit', '10');
		url.searchParams.set('sfw', 'false');

		// Previously a bare `.catch(() => null)` with no logging at all - any
		// failure (network error, timeout, rate limit) looked identical to a
		// genuine "no results", with nothing in the logs to tell them apart.
		const res = await jikanFetch(url.toString()).catch((err) => {
			logger.warn(
				{ query, error: err instanceof Error ? err.message : String(err) },
				'[MAL] Search request failed'
			);
			return null;
		});
		if (!res) return [];
		if (!res.ok) {
			logger.warn(
				{ query, status: res.status, statusText: res.statusText },
				res.status === 429 ? '[MAL] Search rate-limited by Jikan' : '[MAL] Search request not ok'
			);
			return [];
		}
		const body = (await res.json().catch((err) => {
			logger.warn(
				{ query, error: err instanceof Error ? err.message : String(err) },
				'[MAL] Failed to parse search response'
			);
			return null;
		})) as JikanSearchResponse | null;
		const items = body?.data ?? [];

		return items.map((item) => ({
			id: String(item.mal_id),
			title: item.title_english ?? item.title,
			originalTitle: item.title_japanese ?? undefined,
			overview: item.synopsis ?? undefined,
			year: extractYear(item),
			posterUrl: item.images?.jpg?.large_image_url ?? null,
			mediaType: 'anime',
			provider: this.id
		}));
	}

	async getDetails(id: string): Promise<MetadataDetails | null> {
		if (!this.enabled) return null;
		const parsedId = Number.parseInt(id, 10);
		if (!Number.isFinite(parsedId) || parsedId <= 0) return null;

		const url = `https://api.jikan.moe/v4/anime/${parsedId}/full`;
		const res = await jikanFetch(url).catch(() => null);
		if (!res?.ok) return null;
		const body = (await res.json().catch(() => null)) as JikanDetailsResponse | null;
		const item = body?.data;
		if (!item) return null;

		return {
			id: String(item.mal_id),
			title: item.title_english ?? item.title,
			originalTitle: item.title_japanese ?? undefined,
			alternateTitles: buildTitleVariants(item),
			overview: item.synopsis ?? undefined,
			year: extractYear(item),
			posterUrl: item.images?.jpg?.large_image_url ?? null,
			genres: collectGenres(item),
			status: mapStatus(item.status),
			studios: item.studios?.map((s) => s.name) ?? undefined,
			isAdult: isHentai(item),
			mediaType: 'anime',
			provider: this.id
		};
	}
}

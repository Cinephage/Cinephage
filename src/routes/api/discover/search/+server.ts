import type { RequestHandler } from './$types';
import { tmdb } from '#lib/server/tmdb.js';
import { searchMusic } from '#lib/server/catalog/deezerSearch.js';
import { musicBrainz } from '#lib/server/music/musicbrainz.js';
import { contentFilterPipeline } from '#lib/server/filters/ContentFilterPipeline.js';
import { enrichWithReleaseDates } from '#lib/server/release-enrichment.js';
import { z } from 'zod';
import { createChildLogger } from '#lib/logging/index.js';
import { extractSearchYear } from '#lib/utils/search-query.js';

const logger = createChildLogger({ module: 'DiscoverSearchApi', logDomain: 'system' });

const searchQuerySchema = z.object({
	query: z.string().min(1, 'Search query is required'),
	type: z.enum(['all', 'movie', 'tv', 'person', 'music']).default('all'),
	page: z.coerce.number().int().min(1).default(1),
	exclude_in_library: z.enum(['true', 'false']).optional()
});

/** A music row in the search overlay; the card reads `musicKind` for its target. */
interface MusicRow {
	id: string;
	media_type: 'music';
	musicKind: 'album' | 'artist' | 'song';
	title: string;
	/** Song rows open their album, so they carry its title. */
	album_title?: string | null;
	subtitle?: string | null;
	image_url?: string | null;
	year?: number | null;
	primary_type?: string | null;
	/** MusicBrainz id when the row came from the fallback, null for Deezer rows. */
	mbid?: string | null;
	/** Deezer's own ids: the tile links straight to a page Deezer can answer. */
	deezerId?: number | null;
	deezerAlbumId?: number | null;
}

/**
 * The music leg, Deezer first.
 *
 * MusicBrainz is gated at 1.2 s per request, so a one-box search there made
 * Discover crawl. Deezer answers in a few hundred milliseconds and carries
 * covers; MusicBrainz is kept as the fallback so an upstream outage degrades
 * to slow results rather than none. Rows from Deezer carry no MusicBrainz id
 * and resolve one on the detail page.
 */
async function musicRows(query: string): Promise<MusicRow[]> {
	try {
		const rows = await searchMusic(query);
		if (rows.length > 0) {
			return rows.map((row) => ({
				id: row.id,
				media_type: 'music' as const,
				musicKind: row.musicKind,
				title: row.title,
				subtitle: row.subtitle,
				image_url: row.imageUrl,
				year: row.year,
				primary_type: null,
				album_title: row.albumTitle,
				mbid: null,
				deezerId: row.deezerId,
				deezerAlbumId: row.deezerAlbumId
			}));
		}
	} catch (err) {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			'[DiscoverSearch] Deezer music search failed, falling back to MusicBrainz'
		);
	}
	return musicBrainzRows(query);
}

async function musicBrainzRows(query: string): Promise<MusicRow[]> {
	const [albumHits, artistHits] = await Promise.all([
		musicBrainz.searchReleaseGroups({ artist: query, album: query, matchAny: true, limit: 10 }),
		musicBrainz.searchArtists(query, 4)
	]);
	const rows: MusicRow[] = artistHits.map((artist) => ({
		id: artist.mbid,
		media_type: 'music',
		musicKind: 'artist',
		title: artist.name,
		subtitle: artist.disambiguation ?? null,
		image_url: null,
		primary_type: artist.type ?? null,
		mbid: artist.mbid
	}));
	for (const group of albumHits) {
		rows.push({
			id: group.mbid,
			media_type: 'music',
			musicKind: 'album',
			title: group.title,
			subtitle: group.artist.name,
			image_url: `https://coverartarchive.org/release-group/${group.mbid}/front-250`,
			year: group.year ?? null,
			primary_type: group.primaryType ?? null,
			mbid: group.mbid
		});
	}
	return rows;
}

/**
 * The All tab shows music beside video, so it gets a balanced slice: a query
 * like "one more time" returns ten songs, and prepending all of them would
 * bury the movie results. The Music tab keeps the full list.
 */
function balancedMusicRows(rows: MusicRow[], perKind = 4): MusicRow[] {
	const counts = new Map<string, number>();
	return rows.filter((row) => {
		const seen = counts.get(row.musicKind) ?? 0;
		if (seen >= perKind) return false;
		counts.set(row.musicKind, seen + 1);
		return true;
	});
}

/** The shared MusicBrainz rate gate can hold a search behind an add; video
 *  results must never wait on it — music is additive and may miss a page. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error('music search timeout')), ms))
	]);
}

export const GET: RequestHandler = async ({ url }) => {
	const params = Object.fromEntries(url.searchParams.entries());
	const result = searchQuerySchema.safeParse(params);

	if (!result.success) {
		return Response.json(
			{ error: 'Invalid parameters', details: result.error.flatten() },
			{ status: 400 }
		);
	}

	const { query, type, page, exclude_in_library } = result.data;

	// Only the TMDB-serving types need a TMDB key; music-only searches are
	// MusicBrainz's to answer.
	const tmdbConfigured = await tmdb.isConfigured();
	if (type !== 'music' && !tmdbConfigured) {
		return Response.json({ error: 'TMDB API key not configured' }, { status: 503 });
	}

	if (type === 'music') {
		try {
			const rows = await musicRows(query.trim());
			return Response.json({
				results: rows,
				pagination: { page: 1, total_pages: 1, total_results: rows.length }
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Unknown error';
			logger.error({ err: e, ...{ errorMessage: message, query } }, 'Music search failed');
			return Response.json({
				results: [],
				pagination: { page: 1, total_pages: 0, total_results: 0 }
			});
		}
	}

	// Type for TMDB search responses
	interface SearchResponse {
		results: Array<Record<string, unknown> & { id: number }>;
		total_results: number;
		total_pages: number;
	}

	try {
		let results: Array<{ id: number; media_type?: string; [key: string]: unknown }> = [];
		let totalResults = 0;
		let totalPages = 0;
		const { title, year } =
			type === 'movie' || type === 'tv'
				? extractSearchYear(query)
				: { title: query, year: undefined };

		if (type === 'movie') {
			const data = (await tmdb.fetch(
				`/search/movie?query=${encodeURIComponent(title)}&page=${page}${year ? `&year=${year}` : ''}`
			)) as SearchResponse | null;
			if (!data) return Response.json({ error: 'TMDB API key not configured' }, { status: 503 });
			results = data.results.map((m) => ({ ...m, media_type: 'movie' }));
			totalResults = data.total_results;
			totalPages = data.total_pages;
		} else if (type === 'tv') {
			const data = (await tmdb.fetch(
				`/search/tv?query=${encodeURIComponent(title)}&page=${page}${year ? `&first_air_date_year=${year}` : ''}`
			)) as SearchResponse | null;
			if (!data) return Response.json({ error: 'TMDB API key not configured' }, { status: 503 });
			results = data.results.map((t) => ({ ...t, media_type: 'tv' }));
			totalResults = data.total_results;
			totalPages = data.total_pages;
		} else if (type === 'person') {
			const data = (await tmdb.fetch(
				`/search/person?query=${encodeURIComponent(query)}&page=${page}`
			)) as SearchResponse | null;
			if (!data) return Response.json({ error: 'TMDB API key not configured' }, { status: 503 });
			results = data.results.map((p) => ({ ...p, media_type: 'person' }));
			totalResults = data.total_results;
			totalPages = data.total_pages;
		} else {
			// Use multi search for combined results (movies, TV, and persons)
			const data = (await tmdb.fetch(
				`/search/multi?query=${encodeURIComponent(query)}&page=${page}`
			)) as SearchResponse | null;
			if (!data) return Response.json({ error: 'TMDB API key not configured' }, { status: 503 });
			results = data.results;
			totalResults = data.total_results;
			totalPages = data.total_pages;
		}

		// Music rides along on the multi search, in front so it is actually
		// findable; the client overlay dedupes across pages. The video pipeline
		// (tmdbId blocklists, release-date enrichment) never touches music rows.
		let musicMerged: MusicRow[] = [];
		if (type === 'all' && query.trim().length >= 3) {
			try {
				// Deezer answers in ~0.4 s; the cap is the fallback path's guard
				// (MusicBrainz is gated and can queue), not the normal budget.
				musicMerged = balancedMusicRows(await withTimeout(musicRows(query.trim()), 4000));
			} catch {
				// Music is additive; a rate-gated miss only omits the rows.
			}
		}

		const mediaTypeFilter = type === 'movie' ? 'movie' : type === 'tv' ? 'tv' : 'all';
		const { results: filteredResults } = await contentFilterPipeline.apply(results, {
			mediaType: mediaTypeFilter,
			excludeInLibrary: exclude_in_library === 'true'
		});
		const enrichedResults = await enrichWithReleaseDates(filteredResults);

		return Response.json({
			results: [...musicMerged, ...enrichedResults],
			pagination: {
				page,
				total_pages: totalPages,
				// Music rows ride in front of the TMDB page, so they count too.
				total_results: totalResults + musicMerged.length
			}
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Unknown error';
		logger.error({ err: e, ...{ errorMessage: message, query } }, 'Search API error');
		return Response.json({ error: 'Search failed' }, { status: 500 });
	}
};

import { db } from '#lib/server/db/index.js';
import { movies, series, episodes } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import { isGeneratedEpisodeTitle } from './episode-title.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/** Per-item metadata language override mode (mirrors the DB column). */
export type MetadataLanguageMode = 'inherit' | 'original' | 'explicit';

/**
 * Resolve the TMDB request language from the v2 mode/value pair when the
 * original language is already known (row already loaded).
 * - 'explicit' → the stored locale
 * - 'original' → the item's original_language
 * - 'inherit'/null → null (global default)
 */
export function resolveLanguageForFetch(
	mode: string | null | undefined,
	value: string | null | undefined,
	originalLanguage: string | null
): string | null {
	if (mode === 'explicit') return value || null;
	if (mode === 'original') return originalLanguage || null;
	return null;
}

/** Options for {@link resolveLanguage}. */
export interface ResolveLanguageOptions {
	/**
	 * The item's persisted `original_language`. When provided, mode 'original'
	 * never touches the network.
	 */
	originalLanguage?: string | null;
	/**
	 * Called with the probed original language when mode is 'original' and the
	 * persisted value was null, so callers can persist it (lazy backfill).
	 */
	onProbed?: (originalLanguage: string) => Promise<void> | void;
}

/**
 * Resolve the TMDB request language from the v2 mode/value pair.
 * - 'explicit' → the stored locale
 * - 'original' → the persisted original_language; TMDB is probed (via the
 *   details endpoint) only when the persisted value is null, and a successful
 *   probe is reported to `onProbed` for lazy write-back
 * - 'inherit'/null → null (global default)
 */
export async function resolveLanguage(
	mode: string | null | undefined,
	value: string | null | undefined,
	endpoint: string,
	options: ResolveLanguageOptions = {}
): Promise<string | null> {
	if (mode === 'explicit') return value || null;
	if (mode === 'original') {
		if (options.originalLanguage) return options.originalLanguage;
		try {
			const details = await tmdb.fetch(endpoint);
			const d = details as Record<string, unknown>;
			const probed = (d.original_language as string) || null;
			if (probed) await options.onProbed?.(probed);
			return probed;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Derive the deprecated single-string `metadataLanguage` view from the v2 pair
 * (kept one release for old clients): explicit → value, original → 'original',
 * inherit/null → null.
 */
export function metadataLanguageToLegacy(
	mode: string | null | undefined,
	value: string | null | undefined
): string | null {
	if (mode === 'explicit') return value ?? null;
	if (mode === 'original') return 'original';
	return null;
}

let legacyMetadataLanguageWarned = false;

/** Log once per process that the legacy single-string override is deprecated. */
export function warnLegacyMetadataLanguage(source: string): void {
	if (legacyMetadataLanguageWarned) return;
	legacyMetadataLanguageWarned = true;
	logger.warn(
		{ source },
		'metadataLanguage is deprecated; use metadataLanguageMode/metadataLanguageValue'
	);
}

const MOVIE_APPEND_TO_RESPONSE =
	'credits,videos,images,recommendations,similar,watch/providers,release_dates,keywords';
const TV_APPEND_TO_RESPONSE =
	'credits,videos,images,recommendations,similar,watch/providers,content_ratings,keywords';

/**
 * Build a details request path with URLSearchParams so every param is encoded
 * exactly once (no manual `&language=` string interpolation).
 */
function buildDetailsPath(base: string, appendToResponse: string, language: string | null): string {
	// include_image_language is derived from the effective language inside
	// tmdb.fetch so images localize with the rest of the response.
	const params = new URLSearchParams({
		append_to_response: appendToResponse
	});
	if (language) params.set('language', language);
	return `${base}?${params.toString()}`;
}

/** Build an episode request path, with an encoded language param when given. */
function buildEpisodePath(
	tmdbId: number,
	seasonNumber: number,
	episodeNumber: number,
	language: string | null
): string {
	const base = `/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`;
	if (!language) return base;
	return `${base}?${new URLSearchParams({ language }).toString()}`;
}

export async function refreshMovieMetadata(movieId: string): Promise<void> {
	const [movie] = await db
		.select({
			tmdbId: movies.tmdbId,
			metadataLanguageMode: movies.metadataLanguageMode,
			metadataLanguageValue: movies.metadataLanguageValue,
			originalLanguage: movies.originalLanguage
		})
		.from(movies)
		.where(eq(movies.id, movieId));

	if (!movie) return;

	const lang = await resolveLanguage(
		movie.metadataLanguageMode,
		movie.metadataLanguageValue,
		`/movie/${movie.tmdbId}`,
		{
			originalLanguage: movie.originalLanguage,
			onProbed: async (probed) => {
				await db.update(movies).set({ originalLanguage: probed }).where(eq(movies.id, movieId));
				logger.info({ movieId, originalLanguage: probed }, 'Backfilled movie original_language');
			}
		}
	);

	try {
		const details = await tmdb.fetch(
			buildDetailsPath(`/movie/${movie.tmdbId}`, MOVIE_APPEND_TO_RESPONSE, lang)
		);

		const d = details as Record<string, unknown>;
		const updateData: Record<string, unknown> = {};

		if (typeof d.title === 'string') updateData.title = d.title;
		if (typeof d.original_title === 'string') updateData.originalTitle = d.original_title;
		updateData.originalLanguage = (d.original_language as string) || null;
		if (typeof d.overview === 'string') updateData.overview = d.overview;
		if (typeof d.poster_path === 'string') updateData.posterPath = d.poster_path;
		if (typeof d.backdrop_path === 'string') updateData.backdropPath = d.backdrop_path;
		if (typeof d.runtime === 'number') updateData.runtime = d.runtime;
		if (typeof d.release_date === 'string') updateData.releaseDate = d.release_date;

		const rawYear = d.release_date as string | undefined;
		if (rawYear) {
			const year = parseInt(rawYear.substring(0, 4), 10);
			if (!isNaN(year)) updateData.year = year;
		}

		const genres = d.genres as Array<{ name?: string }> | undefined;
		if (genres) {
			updateData.genres = genres.map((g) => g.name).filter(Boolean);
		}

		const adult = d.adult as boolean | undefined;
		if (typeof adult === 'boolean') updateData.adult = adult;

		const belongsToCollection = d.belongs_to_collection as
			{ id: number; name: string } | null | undefined;
		if (belongsToCollection !== undefined) {
			updateData.tmdbCollectionId = belongsToCollection?.id ?? null;
			updateData.collectionName = belongsToCollection?.name ?? null;
		}

		if (Object.keys(updateData).length > 0) {
			await db.update(movies).set(updateData).where(eq(movies.id, movieId));
			logger.info({ movieId, fields: Object.keys(updateData) }, 'Refreshed movie metadata');
		}
	} catch (err) {
		logger.error({ movieId, err }, 'Failed to refresh movie metadata');
	}
}

export async function refreshSeriesMetadata(seriesId: string): Promise<void> {
	const [s] = await db
		.select({
			tmdbId: series.tmdbId,
			metadataLanguageMode: series.metadataLanguageMode,
			metadataLanguageValue: series.metadataLanguageValue,
			originalLanguage: series.originalLanguage
		})
		.from(series)
		.where(eq(series.id, seriesId));

	if (!s) return;

	let probedOriginalLanguage: string | null = null;
	const lang = await resolveLanguage(
		s.metadataLanguageMode,
		s.metadataLanguageValue,
		`/tv/${s.tmdbId}`,
		{
			originalLanguage: s.originalLanguage,
			onProbed: async (probed) => {
				probedOriginalLanguage = probed;
				await db.update(series).set({ originalLanguage: probed }).where(eq(series.id, seriesId));
				logger.info({ seriesId, originalLanguage: probed }, 'Backfilled series original_language');
			}
		}
	);
	// The probed value (when the persisted one was null) is also the best hint
	// for the episode original-language fallback below.
	const seriesOriginalLanguage = s.originalLanguage ?? probedOriginalLanguage;

	try {
		const details = await tmdb.fetch(
			buildDetailsPath(`/tv/${s.tmdbId}`, TV_APPEND_TO_RESPONSE, lang)
		);

		const d = details as Record<string, unknown>;
		const updateData: Record<string, unknown> = {};

		if (typeof d.name === 'string') updateData.title = d.name;
		if (typeof d.original_name === 'string') updateData.originalTitle = d.original_name;
		updateData.originalLanguage = (d.original_language as string) || null;
		if (typeof d.overview === 'string') updateData.overview = d.overview;
		if (typeof d.poster_path === 'string') updateData.posterPath = d.poster_path;
		if (typeof d.backdrop_path === 'string') updateData.backdropPath = d.backdrop_path;
		if (typeof d.status === 'string') updateData.status = d.status;

		const networks = d.networks as Array<{ name?: string }> | undefined;
		if (networks) {
			updateData.network =
				networks
					.map((n) => n.name)
					.filter(Boolean)
					.join(', ') || null;
		}

		const rawYear = d.first_air_date as string | undefined;
		if (rawYear) {
			const year = parseInt(rawYear.substring(0, 4), 10);
			if (!isNaN(year)) updateData.year = year;
		}
		if (typeof d.first_air_date === 'string') updateData.firstAirDate = d.first_air_date;

		const genres = d.genres as Array<{ name?: string }> | undefined;
		if (genres) {
			updateData.genres = genres.map((g) => g.name).filter(Boolean);
		}

		const adult = d.adult as boolean | undefined;
		if (typeof adult === 'boolean') updateData.adult = adult;

		if (Object.keys(updateData).length > 0) {
			await db.update(series).set(updateData).where(eq(series.id, seriesId));
			logger.info({ seriesId, fields: Object.keys(updateData) }, 'Refreshed series metadata');
		}

		await refreshEpisodeMetadata(seriesId, s.tmdbId, lang, seriesOriginalLanguage);
	} catch (err) {
		logger.error({ seriesId, err }, 'Failed to refresh series metadata');
	}
}

async function refreshEpisodeMetadata(
	seriesId: string,
	tmdbId: number,
	language: string | null,
	originalLanguage: string | null
): Promise<void> {
	const epList = await db
		.select({
			id: episodes.id,
			seasonNumber: episodes.seasonNumber,
			episodeNumber: episodes.episodeNumber
		})
		.from(episodes)
		.where(eq(episodes.seriesId, seriesId));

	for (const ep of epList) {
		try {
			const epDetails = await tmdb.fetch(
				buildEpisodePath(tmdbId, ep.seasonNumber, ep.episodeNumber, language)
			);
			const ed = epDetails as Record<string, unknown>;
			const epUpdate: Record<string, unknown> = {};

			let name = typeof ed.name === 'string' ? ed.name : undefined;
			let overview = typeof ed.overview === 'string' ? ed.overview.trim() : '';

			// TMDB synthesizes "Episode N"-style names in the requested language
			// when no real translation exists (e.g. German "Folge 4"). Those are
			// not translations — fall back to the series' original-language data
			// rather than clobbering the real title.
			const needsFallback = name === undefined || isGeneratedEpisodeTitle(name);
			let fallbackLanguage: string | null | undefined;
			if (needsFallback) {
				if (originalLanguage !== null) {
					// Refetch in the series' original language — the authoritative
					// title source — unless the primary request already used it (then
					// the response we have IS the original-language data).
					fallbackLanguage = originalLanguage === language ? undefined : originalLanguage;
				} else if (language !== null) {
					// Original language genuinely unknown — retry unlocalized.
					fallbackLanguage = null;
				}
				// language === null && originalLanguage === null: the primary request
				// had no explicit language, so a retry would return the same data.
			}

			if (fallbackLanguage !== undefined) {
				try {
					const original = (await tmdb.fetch(
						buildEpisodePath(tmdbId, ep.seasonNumber, ep.episodeNumber, fallbackLanguage)
					)) as Record<string, unknown>;
					const originalName = typeof original.name === 'string' ? original.name : undefined;
					if (originalName && !isGeneratedEpisodeTitle(originalName)) {
						name = originalName;
						if (!overview && typeof original.overview === 'string') {
							overview = original.overview.trim();
						}
					}
				} catch {
					// keep localized data if the fallback request fails
				}
			}

			if (name !== undefined && !isGeneratedEpisodeTitle(name)) epUpdate.title = name;
			if (overview) epUpdate.overview = overview;

			if (typeof ed.air_date === 'string' && ed.air_date) epUpdate.airDate = ed.air_date;
			if (typeof ed.runtime === 'number') epUpdate.runtime = ed.runtime;

			if (Object.keys(epUpdate).length > 0) {
				await db.update(episodes).set(epUpdate).where(eq(episodes.id, ep.id));
			}
		} catch {
			// skip individual episode failures
		}

		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	logger.info({ seriesId, episodeCount: epList.length }, 'Refreshed episode metadata');
}

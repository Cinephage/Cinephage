/**
 * TMDB suggestion matching, shared across manual import and the Unmatched
 * tab.
 */
import { basename } from 'node:path';
import { tmdb } from '#lib/server/tmdb.js';
import { extractExternalIds } from '#lib/server/indexers/parser/ReleaseParser.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { getMediaParseStem } from '#lib/server/library/media-utils.js';
import type { MediaType } from '#lib/server/library/LibraryAddService.js';
import { canonicalizeArticleTitle, calculateMatchConfidence } from './title-matching.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

export interface SuggestedMatch {
	tmdbId: number;
	title: string;
	year?: number;
	confidence: number;
	mediaType: MediaType;
	isAnime?: boolean;
}

/**
 * Parse -> external-id lookup -> TMDB search -> confidence score -> top-5,
 * aggregated across every title candidate. `matchCache` (keyed by
 * `${mediaType}:${year}:${title}`) lets callers that process many items
 * sharing a title (season packs, a page of Unmatched downloads) hit TMDB
 * once per unique candidate instead of once per item.
 */
export async function findSuggestedMatches(
	titleCandidates: string[],
	year: number | undefined,
	mediaType: MediaType,
	filePath: string,
	matchCache?: Map<string, SuggestedMatch[]>
): Promise<SuggestedMatch[]> {
	try {
		const extractedIds = extractExternalIds(filePath);

		if (extractedIds.tmdbId) {
			const direct = await lookupByTmdbId(extractedIds.tmdbId, mediaType);
			if (direct) {
				return [direct];
			}
		}

		if (extractedIds.tvdbId) {
			const tvdb = await lookupByTvdbId(extractedIds.tvdbId);
			if (tvdb) {
				return [tvdb];
			}
		}

		if (extractedIds.imdbId) {
			const imdb = await lookupByImdbId(extractedIds.imdbId, mediaType);
			if (imdb) {
				return [imdb];
			}
		}
		const candidates =
			titleCandidates.length > 0 ? titleCandidates : [basename(getMediaParseStem(filePath))];
		const aggregatedMatches = new Map<number, SuggestedMatch>();

		for (const candidate of candidates) {
			// Canonicalize inverted-article candidates ("Lion King, The") so
			// the TMDB query and confidence scoring use the canonical form.
			const canonicalCandidate = canonicalizeArticleTitle(candidate);
			const cacheKey = `${mediaType}:${year ?? 'na'}:${canonicalCandidate.toLowerCase()}`;
			let cachedMatches = matchCache?.get(cacheKey);

			if (!cachedMatches) {
				const results =
					mediaType === 'movie'
						? await tmdb.searchMovies(canonicalCandidate, year, true)
						: await tmdb.searchTv(canonicalCandidate, year, true);

				cachedMatches =
					results.results?.slice(0, 10).map((result) => {
						const resultTitle = result.title || result.name || '';
						const resultDate = result.release_date || result.first_air_date;
						const resultYear = resultDate ? parseInt(resultDate.split('-')[0], 10) : undefined;

						return {
							tmdbId: result.id,
							title: resultTitle,
							year: resultYear,
							confidence: calculateMatchConfidence(
								canonicalCandidate,
								year,
								resultTitle,
								resultYear,
								result.original_title ?? result.original_name
							),
							mediaType,
							isAnime: classifyTmdbResultAnime(result, mediaType)
						} satisfies SuggestedMatch;
					}) ?? [];

				matchCache?.set(cacheKey, cachedMatches);
			}

			for (const match of cachedMatches) {
				const existing = aggregatedMatches.get(match.tmdbId);
				if (!existing || match.confidence > existing.confidence) {
					aggregatedMatches.set(match.tmdbId, { ...match });
				}
			}
		}

		const matches = [...aggregatedMatches.values()];
		matches.sort((a, b) => b.confidence - a.confidence);
		return matches.slice(0, 5);
	} catch (error) {
		logger.error(
			{
				err: error instanceof Error ? error : undefined,
				...{
					titleCandidates,
					mediaType
				}
			},
			'[SuggestedMatches] Failed to find TMDB matches'
		);
		return [];
	}
}

async function lookupByTmdbId(
	tmdbId: number,
	mediaType: MediaType
): Promise<SuggestedMatch | null> {
	try {
		if (mediaType === 'movie') {
			const movie = await tmdb.getMovie(tmdbId);
			return {
				tmdbId: movie.id,
				title: movie.title,
				year: movie.release_date ? parseInt(movie.release_date.split('-')[0], 10) : undefined,
				confidence: 1,
				mediaType,
				isAnime: isLikelyAnimeMedia({
					genres: movie.genres,
					originalLanguage: movie.original_language,
					originCountries: movie.production_countries?.map((country) => country.iso_3166_1),
					productionCountries: movie.production_countries,
					title: movie.title,
					originalTitle: movie.original_title
				})
			};
		}
		const show = await tmdb.getTVShow(tmdbId);
		return {
			tmdbId: show.id,
			title: show.name,
			year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0], 10) : undefined,
			confidence: 1,
			mediaType,
			isAnime: isLikelyAnimeMedia({
				genres: show.genres,
				originalLanguage: show.original_language,
				originCountries: show.origin_country,
				title: show.name,
				originalTitle: show.original_name
			})
		};
	} catch {
		return null;
	}
}

async function lookupByTvdbId(tvdbId: number): Promise<SuggestedMatch | null> {
	try {
		const result = await tmdb.findByExternalId(String(tvdbId), 'tvdb_id');
		if (result.tv_results.length === 0) {
			return null;
		}
		const show = result.tv_results[0];
		return {
			tmdbId: show.id,
			title: show.name,
			year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0], 10) : undefined,
			confidence: 1,
			mediaType: 'tv',
			isAnime: classifyTmdbResultAnime(show, 'tv')
		};
	} catch {
		return null;
	}
}

async function lookupByImdbId(
	imdbId: string,
	preferredMediaType: MediaType
): Promise<SuggestedMatch | null> {
	try {
		const result = await tmdb.findByExternalId(imdbId, 'imdb_id');

		if (preferredMediaType === 'movie' && result.movie_results.length > 0) {
			const movie = result.movie_results[0];
			return {
				tmdbId: movie.id,
				title: movie.title,
				year: movie.release_date ? parseInt(movie.release_date.split('-')[0], 10) : undefined,
				confidence: 1,
				mediaType: 'movie',
				isAnime: classifyTmdbResultAnime(movie, 'movie')
			};
		}

		if (preferredMediaType === 'tv' && result.tv_results.length > 0) {
			const show = result.tv_results[0];
			return {
				tmdbId: show.id,
				title: show.name,
				year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0], 10) : undefined,
				confidence: 1,
				mediaType: 'tv',
				isAnime: classifyTmdbResultAnime(show, 'tv')
			};
		}

		if (result.movie_results.length > 0) {
			const movie = result.movie_results[0];
			return {
				tmdbId: movie.id,
				title: movie.title,
				year: movie.release_date ? parseInt(movie.release_date.split('-')[0], 10) : undefined,
				confidence: 1,
				mediaType: 'movie',
				isAnime: classifyTmdbResultAnime(movie, 'movie')
			};
		}

		if (result.tv_results.length > 0) {
			const show = result.tv_results[0];
			return {
				tmdbId: show.id,
				title: show.name,
				year: show.first_air_date ? parseInt(show.first_air_date.split('-')[0], 10) : undefined,
				confidence: 1,
				mediaType: 'tv',
				isAnime: classifyTmdbResultAnime(show, 'tv')
			};
		}
	} catch {
		return null;
	}
	return null;
}

function classifyTmdbResultAnime(result: Record<string, unknown>, mediaType: MediaType): boolean {
	const genreIds = Array.isArray(result.genre_ids)
		? result.genre_ids.filter((value): value is number => typeof value === 'number')
		: [];
	const originCountries = Array.isArray(result.origin_country)
		? result.origin_country.filter((value): value is string => typeof value === 'string')
		: [];
	const originalLanguage =
		typeof result.original_language === 'string' ? result.original_language : null;
	const title =
		mediaType === 'movie'
			? typeof result.title === 'string'
				? result.title
				: null
			: typeof result.name === 'string'
				? result.name
				: null;
	const originalTitle =
		mediaType === 'movie'
			? typeof result.original_title === 'string'
				? result.original_title
				: null
			: typeof result.original_name === 'string'
				? result.original_name
				: null;

	return isLikelyAnimeMedia({
		genres: genreIds.map((id) => ({ id })),
		originalLanguage,
		originCountries,
		title,
		originalTitle
	});
}

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { movies } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { bulkAddMoviesSchema } from '#lib/validation/schemas.js';
import { buildMovieFolderName } from '#lib/server/library/naming/naming-helpers.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import {
	extractLanguageCodes,
	resolveLocalizedTitles
} from '#lib/server/library/naming/localization.js';
import {
	validateRootFolder,
	getAnimeSubtypeEnforcement,
	getEffectiveScoringProfileId,
	fetchMovieDetails,
	fetchMovieExternalIds,
	triggerMovieSearch
} from '#lib/server/library/LibraryAddService.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { ValidationError } from '#lib/errors/index.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMoviesBulkApi', logDomain: 'scans' });

interface BulkAddResult {
	added: number;
	skipped: number;
	errors: { tmdbId: number; title?: string; error: string }[];
	movies: { id: string; tmdbId: number; title: string }[];
}

/**
 * POST /api/library/movies/bulk
 * Add multiple movies to the library by TMDB IDs
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const result = bulkAddMoviesSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const {
			tmdbIds,
			rootFolderId,
			scoringProfileId,
			monitored,
			minimumAvailability,
			availabilityDelay,
			searchOnAdd: shouldSearch,
			wantsSubtitles
		} = result.data;

		// Verify root folder exists and is for movies
		await validateRootFolder(rootFolderId, 'movie', { requireWritable: true });
		const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
			rootFolderId,
			'movie'
		);
		const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();

		// Check which movies already exist in library
		const existingMovies = await db
			.select({ tmdbId: movies.tmdbId })
			.from(movies)
			.where(inArray(movies.tmdbId, tmdbIds));

		const existingTmdbIds = new Set(existingMovies.map((m) => m.tmdbId));

		// Filter to only movies that need to be added
		const moviesToAdd = tmdbIds.filter((id) => !existingTmdbIds.has(id));

		// Get the effective scoring profile once (shared across all movies)
		const effectiveProfileId = await getEffectiveScoringProfileId(scoringProfileId, owningLibrary);

		const results: BulkAddResult = {
			added: 0,
			skipped: existingTmdbIds.size,
			errors: [],
			movies: []
		};

		// Add each movie
		for (const tmdbId of moviesToAdd) {
			try {
				// Fetch movie details from TMDB
				const movieDetails = await fetchMovieDetails(tmdbId);
				const isAnimeMedia = isLikelyAnimeMedia({
					genres: movieDetails.genres,
					originalLanguage: movieDetails.original_language,
					originCountries: movieDetails.production_countries?.map((country) => country.iso_3166_1),
					productionCountries: movieDetails.production_countries,
					title: movieDetails.title,
					originalTitle: movieDetails.original_title
				});

				if (enforceAnimeSubtype) {
					await validateRootFolder(rootFolderId, 'movie', {
						enforceAnimeSubtype,
						isAnimeMedia,
						mediaTitle: movieDetails.title
					});
				}

				// Generate folder path
				const year = movieDetails.release_date
					? new Date(movieDetails.release_date).getFullYear()
					: undefined;
				const collectionData = movieDetails.belongs_to_collection;
				const namingConfig = namingSettingsService.getConfigSync();
				const langCodes = [
					...extractLanguageCodes(namingConfig.movieFolderFormat),
					...extractLanguageCodes(namingConfig.movieFileFormat)
				];
				const uniqueLangCodes = [...new Set(langCodes)];
				const localizedTitles =
					uniqueLangCodes.length > 0
						? await resolveLocalizedTitles(tmdbId, uniqueLangCodes)
						: undefined;
				const folderName = buildMovieFolderName(
					movieDetails.title,
					year,
					tmdbId,
					collectionData?.name,
					localizedTitles,
					movieDetails.original_title
				);

				// Extract external IDs
				const { imdbId } = await fetchMovieExternalIds(tmdbId);

				// Insert movie into database
				const [newMovie] = await db
					.insert(movies)
					.values({
						tmdbId,
						imdbId,
						title: movieDetails.title,
						originalLanguage: movieDetails.original_language,
						originalTitle: movieDetails.original_title,
						year,
						overview: movieDetails.overview,
						posterPath: movieDetails.poster_path,
						backdropPath: movieDetails.backdrop_path,
						runtime: movieDetails.runtime,
						genres: movieDetails.genres?.map((g) => g.name) ?? [],
						path: folderName,
						libraryId: owningLibrary.id,
						rootFolderId,
						scoringProfileId: effectiveProfileId,
						monitored,
						minimumAvailability,
						availabilityDelay,
						hasFile: false,
						wantsSubtitles,
						tmdbCollectionId: collectionData?.id ?? null,
						collectionName: collectionData?.name ?? null,
						releaseDate: movieDetails.release_date ?? null
					})
					.returning();

				results.added++;
				results.movies.push({
					id: newMovie.id,
					tmdbId: newMovie.tmdbId,
					title: newMovie.title
				});

				// Trigger search if requested and movie is monitored
				if (shouldSearch && monitored) {
					await triggerMovieSearch({
						movieId: newMovie.id,
						tmdbId,
						imdbId,
						title: movieDetails.title,
						year,
						scoringProfileId
					});
				}
			} catch (error) {
				logger.error(
					{
						err: error instanceof Error ? error : undefined,
						...{
							tmdbId
						}
					},
					'[API] Error adding movie in bulk'
				);
				results.errors.push({
					tmdbId,
					error: error instanceof Error ? error.message : 'Failed to add movie'
				});
			}
		}

		if (results.added > 0) {
			libraryMediaEvents.emitLibraryDataChanged({
				source: 'movie',
				reason: 'bulk-movies-added'
			});
		}

		return Response.json({
			success: true,
			...results
		});
	} catch (error) {
		logger.error('[API] Error in bulk movie add', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to add movies'
			},
			{ status: 500 }
		);
	}
};

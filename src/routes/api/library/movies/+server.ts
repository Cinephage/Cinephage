import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { movies, movieFiles, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { addMovieSchema } from '#lib/validation/schemas.js';
import { addMovieToLibrary } from '#lib/server/library/add/add-movie.js';
import { ValidationError, isAppError } from '#lib/errors/index.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMoviesApi', logDomain: 'scans' });

/**
 * GET /api/library/movies
 * List all movies in the library
 */
export const GET: RequestHandler = async (event) => {
	// Require authentication
	const authError = requireAuth(event);
	if (authError) return authError;

	try {
		// Fetch all movies (1 query)
		const allMovies = await db
			.select({
				id: movies.id,
				tmdbId: movies.tmdbId,
				imdbId: movies.imdbId,
				title: movies.title,
				originalTitle: movies.originalTitle,
				year: movies.year,
				overview: movies.overview,
				posterPath: movies.posterPath,
				backdropPath: movies.backdropPath,
				runtime: movies.runtime,
				genres: movies.genres,
				path: movies.path,
				rootFolderId: movies.rootFolderId,
				rootFolderPath: rootFolders.path,
				rootFolderMediaType: rootFolders.mediaType,
				scoringProfileId: movies.scoringProfileId,
				desiredQualities: movies.desiredQualities,
				monitored: movies.monitored,
				minimumAvailability: movies.minimumAvailability,
				added: movies.added,
				hasFile: movies.hasFile,
				tmdbCollectionId: movies.tmdbCollectionId,
				collectionName: movies.collectionName,
				releaseDate: movies.releaseDate,
				digitalReleaseDate: movies.digitalReleaseDate,
				physicalReleaseDate: movies.physicalReleaseDate,
				availabilityDelay: movies.availabilityDelay
			})
			.from(movies)
			.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id));

		// Fetch all movie files in a single query (1 query instead of N)
		const allFiles = await db.select().from(movieFiles);

		// Group files by movieId in memory (O(n) complexity, much faster than N queries)
		const filesByMovieId = new Map<string, typeof allFiles>();
		for (const file of allFiles) {
			const existing = filesByMovieId.get(file.movieId) || [];
			existing.push(file);
			filesByMovieId.set(file.movieId, existing);
		}

		// Map movies with their files (O(n) memory operation)
		const moviesWithFiles = allMovies.map((movie) => {
			const files = filesByMovieId.get(movie.id) || [];
			return {
				...movie,
				missingRootFolder:
					!movie.rootFolderId || !movie.rootFolderPath || movie.rootFolderMediaType !== 'movie',
				files: files.map((f) => ({
					id: f.id,
					relativePath: f.relativePath,
					size: f.size,
					dateAdded: f.dateAdded,
					quality: f.quality,
					mediaInfo: f.mediaInfo,
					releaseGroup: f.releaseGroup,
					edition: f.edition
				}))
			};
		});

		return Response.json({
			success: true,
			movies: moviesWithFiles,
			total: moviesWithFiles.length
		});
	} catch (error) {
		logger.error('[API] Error fetching movies', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch movies'
			},
			{ status: 500 }
		);
	}
};

/**
 * POST /api/library/movies
 * Add a movie to the library by TMDB ID
 */
export const POST: RequestHandler = async (event) => {
	const { request } = event;

	// Require authentication
	const authError = requireAuth(event);
	if (authError) return authError;

	try {
		const body = await request.json();
		const result = addMovieSchema.safeParse(body);

		if (!result.success) {
			throw new ValidationError('Validation failed', {
				details: result.error.flatten()
			});
		}

		const addResult = await addMovieToLibrary(result.data);

		if (addResult.outcome === 'exists') {
			return Response.json(
				{
					success: false,
					error: 'Movie already exists in library',
					movieId: addResult.movieId
				},
				{ status: 409 }
			);
		}

		return Response.json({
			success: true,
			movie: {
				id: addResult.movieId,
				tmdbId: addResult.tmdbId,
				title: addResult.title,
				year: addResult.year,
				path: addResult.path,
				monitored: addResult.monitored,
				searchTriggered: addResult.searchTriggered,
				searchWarning: addResult.searchWarning
			}
		});
	} catch (error) {
		logger.error('[API] Error adding movie', error instanceof Error ? error : undefined);

		if (isAppError(error)) {
			return Response.json(
				{
					success: false,
					...error.toJSON()
				},
				{ status: error.statusCode }
			);
		}

		if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
			return Response.json(
				{
					success: false,
					error:
						'The selected root folder or one of its linked library settings is no longer valid. Refresh the page and try again.',
					code: 'LIBRARY_CONFIGURATION_STALE'
				},
				{ status: 409 }
			);
		}

		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to add movie'
			},
			{ status: 500 }
		);
	}
};

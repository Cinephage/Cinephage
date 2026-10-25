import type { RequestHandler } from './$types';
import { z } from 'zod';
import { db } from '#lib/server/db/index.js';
import { movies } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
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
import { fetchAndStoreMovieAlternateTitles } from '#lib/server/services/AlternateTitleService.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryCollectionsTrackApi', logDomain: 'scans' });

const trackSchema = z.object({
	rootFolderId: z.string().min(1),
	scoringProfileId: z.string().optional(),
	monitored: z.boolean().default(true),
	searchOnAdd: z.boolean().default(false)
});

export const POST: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const tmdbCollectionId = parseInt(event.params.tmdbId, 10);
	if (isNaN(tmdbCollectionId)) {
		return Response.json({ success: false, error: 'Invalid collection ID' }, { status: 400 });
	}

	const body = await event.request.json().catch(() => null);
	const parsed = trackSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 });
	}

	const { rootFolderId, scoringProfileId, monitored, searchOnAdd: shouldSearch } = parsed.data;

	const collection = await tmdb.getCollection(tmdbCollectionId).catch((err) => {
		logger.warn(
			{ tmdbCollectionId, error: err instanceof Error ? err.message : String(err) },
			'[TrackCollection] Failed to fetch collection from TMDB'
		);
		return null;
	});

	if (!collection) {
		return Response.json(
			{ success: false, error: 'Collection not found on TMDB' },
			{ status: 404 }
		);
	}

	const parts = collection.parts ?? [];
	if (parts.length === 0) {
		return Response.json({ success: true, added: 0, skipped: 0, errors: [] });
	}

	// Find which parts are already in the library
	const existingTmdbIds = new Set(
		(
			await db
				.select({ tmdbId: movies.tmdbId })
				.from(movies)
				.where(eq(movies.tmdbCollectionId, tmdbCollectionId))
		).map((m) => m.tmdbId)
	);

	const missing = parts.filter((p) => !existingTmdbIds.has(p.id));

	if (missing.length === 0) {
		return Response.json({ success: true, added: 0, skipped: parts.length, errors: [] });
	}

	const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();
	const collectionOwningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
		rootFolderId,
		'movie'
	);
	const effectiveProfileId = await getEffectiveScoringProfileId(
		scoringProfileId,
		collectionOwningLibrary
	);
	const namingConfig = namingSettingsService.getConfigSync();
	const langCodes = [
		...new Set([
			...extractLanguageCodes(namingConfig.movieFolderFormat),
			...extractLanguageCodes(namingConfig.movieFileFormat)
		])
	];

	const results = { added: 0, skipped: existingTmdbIds.size, errors: [] as string[] };

	for (const part of missing) {
		try {
			const movieDetails = await fetchMovieDetails(part.id);

			const isAnimeMedia = isLikelyAnimeMedia({
				genres: movieDetails.genres,
				originalLanguage: movieDetails.original_language,
				originCountries: movieDetails.production_countries?.map((c) => c.iso_3166_1),
				productionCountries: movieDetails.production_countries,
				title: movieDetails.title,
				originalTitle: movieDetails.original_title
			});

			await validateRootFolder(rootFolderId, 'movie', {
				requireWritable: true,
				enforceAnimeSubtype,
				isAnimeMedia,
				mediaTitle: movieDetails.title
			});

			const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
				rootFolderId,
				'movie'
			);

			const year = movieDetails.release_date
				? new Date(movieDetails.release_date).getFullYear()
				: undefined;

			const collectionData = movieDetails.belongs_to_collection;

			const localizedTitles =
				langCodes.length > 0 ? await resolveLocalizedTitles(part.id, langCodes) : undefined;

			const folderName = buildMovieFolderName(
				movieDetails.title,
				year,
				part.id,
				collectionData?.name,
				localizedTitles,
				movieDetails.original_title
			);

			const { imdbId } = await fetchMovieExternalIds(part.id);

			const [newMovie] = await db
				.insert(movies)
				.values({
					tmdbId: part.id,
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
					minimumAvailability: 'released',
					availabilityDelay: 0,
					hasFile: false,
					wantsSubtitles: true,
					tmdbCollectionId: collectionData?.id ?? tmdbCollectionId,
					collectionName: collectionData?.name ?? collection.name,
					releaseDate: movieDetails.release_date ?? null
				})
				.returning();

			fetchAndStoreMovieAlternateTitles(newMovie.id, part.id).catch(() => {});

			if (shouldSearch) {
				await triggerMovieSearch({
					movieId: newMovie.id,
					tmdbId: part.id,
					imdbId,
					title: movieDetails.title,
					year,
					scoringProfileId: effectiveProfileId
				}).catch(() => {});
			}

			libraryMediaEvents.emitLibraryDataChanged({
				source: 'movie',
				reason: 'movie-added',
				entityId: newMovie.id
			});

			results.added++;
		} catch (err) {
			logger.warn(
				{
					tmdbId: part.id,
					title: part.title,
					error: err instanceof Error ? err.message : String(err)
				},
				'[TrackCollection] Failed to add collection part'
			);
			results.errors.push(`${part.title}: ${err instanceof Error ? err.message : 'Unknown error'}`);
		}
	}

	return Response.json({ success: true, ...results });
};

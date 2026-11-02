import { db } from '#lib/server/db/index.js';
import { movies } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
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
import { ValidationError } from '#lib/errors/index.js';
import type { AddMovieRequest } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MovieAdd', logDomain: 'scans' });

export type AddMovieInput = AddMovieRequest;

export type AddMovieResult =
	| {
			outcome: 'added';
			movieId: string;
			tmdbId: number;
			title: string;
			year: number | null;
			path: string;
			monitored: boolean;
			searchTriggered: boolean;
			searchWarning?: string;
	  }
	| { outcome: 'exists'; movieId: string };

/**
 * Shared movie-add orchestration. This is the single implementation behind
 * both POST /api/library/movies and request approval — do not duplicate it
 * in new call sites. App-level validation errors (root folder, language
 * profile, anime subtype enforcement) throw ValidationError; TMDB failures
 * surface as fetchMovieDetails rejections, same as the HTTP path.
 */
export async function addMovieToLibrary(input: AddMovieInput): Promise<AddMovieResult> {
	const {
		tmdbId,
		rootFolderId,
		scoringProfileId,
		desiredQualities,
		monitored,
		minimumAvailability,
		availabilityDelay,
		searchOnAdd: shouldSearch,
		wantsSubtitles,
		languageProfileId,
		subtitleRequirementsOverride
	} = input;

	// A client-provided language profile must exist.
	if (languageProfileId) {
		const languageProfile = await getLanguageProfileService().getProfile(languageProfileId);
		if (!languageProfile) {
			throw new ValidationError(`Language profile not found: ${languageProfileId}`);
		}
	}

	const existingMovie = await db
		.select({ id: movies.id })
		.from(movies)
		.where(eq(movies.tmdbId, tmdbId))
		.limit(1);

	if (existingMovie.length > 0) {
		return { outcome: 'exists', movieId: existingMovie[0].id };
	}

	const movieDetails = await fetchMovieDetails(tmdbId);
	const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();
	const isAnimeMedia = isLikelyAnimeMedia({
		genres: movieDetails.genres,
		originalLanguage: movieDetails.original_language,
		originCountries: movieDetails.production_countries?.map((country) => country.iso_3166_1),
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
	const namingConfig = namingSettingsService.getConfigSync();
	const langCodes = [
		...extractLanguageCodes(namingConfig.movieFolderFormat),
		...extractLanguageCodes(namingConfig.movieFileFormat)
	];
	const uniqueLangCodes = [...new Set(langCodes)];
	const localizedTitles =
		uniqueLangCodes.length > 0 ? await resolveLocalizedTitles(tmdbId, uniqueLangCodes) : undefined;
	const folderName = buildMovieFolderName(
		movieDetails.title,
		year,
		tmdbId,
		collectionData?.name,
		localizedTitles,
		movieDetails.original_title
	);

	const { imdbId } = await fetchMovieExternalIds(tmdbId);
	const effectiveProfileId = await getEffectiveScoringProfileId(scoringProfileId, owningLibrary);

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
			desiredQualities: desiredQualities ?? null,
			monitored,
			minimumAvailability,
			availabilityDelay,
			hasFile: false,
			wantsSubtitles,
			languageProfileId: languageProfileId ?? null,
			subtitleRequirementsOverride: subtitleRequirementsOverride ?? null,
			tmdbCollectionId: collectionData?.id ?? null,
			collectionName: collectionData?.name ?? null,
			releaseDate: movieDetails.release_date ?? null
		})
		.returning();

	fetchAndStoreMovieAlternateTitles(newMovie.id, tmdbId).catch((err) => {
		logger.warn(
			{
				movieId: newMovie.id,
				tmdbId,
				error: err instanceof Error ? err.message : String(err)
			},
			'Failed to fetch alternate titles for movie'
		);
	});

	let searchTriggered = false;
	let searchWarning: string | undefined;
	if (shouldSearch) {
		const searchResult = await triggerMovieSearch({
			movieId: newMovie.id,
			tmdbId,
			imdbId,
			title: movieDetails.title,
			year,
			scoringProfileId
		});
		searchTriggered = searchResult.triggered;
		searchWarning = searchResult.searchWarning;
	}

	libraryMediaEvents.emitLibraryDataChanged({
		source: 'movie',
		reason: 'movie-added',
		entityId: newMovie.id,
		tmdbId
	});

	return {
		outcome: 'added',
		movieId: newMovie.id,
		tmdbId,
		title: newMovie.title,
		year: newMovie.year ?? null,
		path: newMovie.path,
		monitored: newMovie.monitored ?? true,
		searchTriggered,
		searchWarning
	};
}

import { db } from '#lib/server/db/index.js';
import { delayProfileService } from '#lib/server/monitoring/specifications/DelaySpecification.js';
import {
	movies,
	movieFiles,
	rootFolders,
	scoringProfiles,
	downloadQueue,
	subtitles,
	libraries
} from '#lib/server/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { LibraryMovie, MovieFile, QualityProfileSummary } from '#lib/types/library.js';
import type { MovieDetails } from '#lib/types/tmdb.js';
import { tmdb } from '#lib/server/tmdb.js';
import { isMovieSearching } from '#lib/server/library/ActiveSearchTracker.js';
import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';
import { getMetadataProviderConfig } from '#lib/server/metadata/provider-settings.js';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { getLanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import type { SubtitleStatus } from '#lib/server/subtitles/types.js';
import type {
	EffectiveLanguageProfile,
	EffectiveSubtitleRequirements
} from '#lib/shared/language-profile.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMoviePage', logDomain: 'scans' });

export interface QueueItemInfo {
	id: string;
	title: string;
	status: string;
	progress: number | null;
}

export interface CollectionPart {
	tmdbId: number;
	title: string;
	year: number | null;
	posterPath: string | null;
	releaseDate: string | null;
	inLibrary: boolean;
	movieId: string | null;
	hasFile: boolean | null;
	hasSubtitles: boolean;
}

export interface CollectionInfo {
	tmdbId: number;
	name: string;
	posterPath: string | null;
	backdropPath: string | null;
	parts: CollectionPart[];
}

export interface LibraryMoviePageData {
	movie: LibraryMovie;
	librarySlug: string | null;
	libraryName: string | null;
	tmdbDetails: MovieDetails | null;
	qualityProfiles: QualityProfileSummary[];
	delayProfiles: Array<{
		id: string;
		name: string;
		torrentDelay: number;
		usenetDelay: number;
		enabled: boolean | null;
		preferredProtocol: string | null;
		bypassIfHighestQuality: boolean | null;
		bypassIfAboveScore: number | null;
	}>;
	rootFolders: Array<{
		id: string;
		name: string;
		path: string;
		mediaType: string;
		mediaSubType: string | null;
		freeSpaceBytes: number | null;
	}>;
	queueItem: QueueItemInfo | null;
	isSearching: boolean;
	configuredMetadataProviders: {
		anilist: boolean;
		mal: boolean;
	};
	collection: CollectionInfo | null;
	/** Requirement-aware subtitle status for the movie (effective profile applied). */
	subtitleStatus: SubtitleStatus;
	effectiveSubtitleRequirements: EffectiveSubtitleRequirements | null;
	/** The profile governing the movie plus the level it was resolved from. */
	effectiveLanguageProfile: EffectiveLanguageProfile | null;
	/** Language profiles available for the per-item subtitle profile override. */
	languageProfiles: Array<{ id: string; name: string }>;
	/** Instance default for original-title display (language_settings.prefer_original_title). */
	preferOriginalTitleDefault: boolean;
}

export const load: PageServerLoad = async ({ params }): Promise<LibraryMoviePageData> => {
	const { id } = params;

	// Fetch the movie with root folder info
	const movieResult = await db
		.select({
			id: movies.id,
			tmdbId: movies.tmdbId,
			imdbId: movies.imdbId,
			providerRefs: movies.providerRefs,
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
			scoringProfileId: movies.scoringProfileId,
			desiredQualities: movies.desiredQualities,
			monitored: movies.monitored,
			minimumAvailability: movies.minimumAvailability,
			wantsSubtitles: movies.wantsSubtitles,
			added: movies.added,
			hasFile: movies.hasFile,
			tmdbCollectionId: movies.tmdbCollectionId,
			collectionName: movies.collectionName,
			releaseDate: movies.releaseDate,
			digitalReleaseDate: movies.digitalReleaseDate,
			physicalReleaseDate: movies.physicalReleaseDate,
			availabilityDelay: movies.availabilityDelay,
			downloadReleaseDate: movies.downloadReleaseDate,
			downloadReleaseType: movies.downloadReleaseType,
			libraryId: movies.libraryId,
			librarySlug: libraries.slug,
			libraryName: libraries.name,
			libraryIsDefault: libraries.isDefault,
			languageProfileId: movies.languageProfileId,
			metadataLanguageMode: movies.metadataLanguageMode,
			metadataLanguageValue: movies.metadataLanguageValue,
			metadataLanguage: movies.metadataLanguage,
			preferOriginalTitle: movies.preferOriginalTitle,
			languageShortfall: movies.languageShortfall
		})
		.from(movies)
		.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
		.leftJoin(libraries, eq(movies.libraryId, libraries.id))
		.where(eq(movies.id, id));

	if (movieResult.length === 0) {
		error(404, 'Movie not found in library');
	}

	const movie = movieResult[0];

	const profileService = getLanguageProfileService();
	const [
		files,
		movieSubtitles,
		releaseInfo,
		tmdbDetails,
		subtitleStatus,
		effectiveLanguageProfile,
		effectiveSubtitleRequirements
	] = await Promise.all([
		db.select().from(movieFiles).where(eq(movieFiles.movieId, id)),
		db
			.select({
				id: subtitles.id,
				language: subtitles.language,
				isForced: subtitles.isForced,
				isHearingImpaired: subtitles.isHearingImpaired,
				format: subtitles.format,
				matchScore: subtitles.matchScore,
				providerId: subtitles.providerId,
				dateAdded: subtitles.dateAdded,
				wasSynced: subtitles.wasSynced,
				syncOffset: subtitles.syncOffset
			})
			.from(subtitles)
			.where(eq(subtitles.movieId, id)),
		tmdb.getMovieReleaseInfo(movie.tmdbId).catch((err) => {
			logger.warn(
				{
					movieId: id,
					tmdbId: movie.tmdbId,
					error: err instanceof Error ? err.message : String(err)
				},
				'[LibraryMovie] Failed to fetch TMDB release info'
			);
			return null;
		}),
		tmdb.getMovie(movie.tmdbId).catch((err) => {
			logger.warn(
				{
					movieId: id,
					tmdbId: movie.tmdbId,
					error: err instanceof Error ? err.message : String(err)
				},
				'[LibraryMovie] Failed to fetch TMDB movie details'
			);
			return null;
		}),
		// Same computation as GET /api/library/movies/[id] — reuse the service
		// directly instead of self-fetching the API.
		profileService.getMovieSubtitleStatus(id),
		profileService.getEffectiveProfileForMovie(id),
		profileService.getEffectiveSubtitleRequirements({ movieId: id })
	]);
	const languageSettings = await getLanguageSettingsService().get();
	const preferOriginalTitleDefault = languageSettings.preferOriginalTitle;

	const movieWithFiles: LibraryMovie = {
		...movie,
		metadataLanguageMode: movie.metadataLanguageMode as 'inherit' | 'original' | 'explicit',
		tmdbStatus: releaseInfo?.status ?? null,
		releaseDate: releaseInfo?.release_date ?? null,
		// Ensure added is always a string
		added: movie.added ?? new Date().toISOString(),
		files: files.map((f) => ({
			id: f.id,
			relativePath: f.relativePath,
			size: f.size,
			dateAdded: f.dateAdded,
			quality: f.quality as MovieFile['quality'],
			mediaInfo: f.mediaInfo as MovieFile['mediaInfo'],
			releaseGroup: f.releaseGroup,
			edition: f.edition
		})),
		subtitles: movieSubtitles.map((s) => ({
			id: s.id,
			language: s.language,
			isForced: s.isForced ?? undefined,
			isHearingImpaired: s.isHearingImpaired ?? undefined,
			format: s.format ?? undefined,
			matchScore: s.matchScore,
			providerId: s.providerId,
			dateAdded: s.dateAdded,
			wasSynced: s.wasSynced ?? undefined,
			syncOffset: s.syncOffset
		}))
	};

	const dbProfiles = await db
		.select({
			id: scoringProfiles.id,
			name: scoringProfiles.name,
			description: scoringProfiles.description,
			isDefault: scoringProfiles.isDefault,
			isBuiltIn: scoringProfiles.isBuiltIn,
			minResolution: scoringProfiles.minResolution,
			maxResolution: scoringProfiles.maxResolution
		})
		.from(scoringProfiles);

	const resolvedDefaultId =
		dbProfiles.find((p) => !p.isBuiltIn && p.isDefault)?.id ??
		dbProfiles.find((p) => p.isBuiltIn && p.isDefault)?.id ??
		'balanced';

	const allQualityProfiles: QualityProfileSummary[] = dbProfiles.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description ?? '',
		isBuiltIn: !!p.isBuiltIn,
		isDefault: p.id === resolvedDefaultId,
		minResolution: p.minResolution ?? null,
		maxResolution: p.maxResolution ?? null
	}));

	// Language profiles for the edit modal's subtitle-profile override select.
	const languageProfiles = (await profileService.getProfiles()).map((p) => ({
		id: p.id,
		name: p.name
	}));

	// Fetch movie root folders for the edit modal
	const folders = await db
		.select({
			id: rootFolders.id,
			name: rootFolders.name,
			path: rootFolders.path,
			mediaType: rootFolders.mediaType,
			mediaSubType: rootFolders.mediaSubType,
			freeSpaceBytes: rootFolders.freeSpaceBytes
		})
		.from(rootFolders)
		.where(eq(rootFolders.mediaType, 'movie'));

	// Fetch active queue item for this movie
	const queueResults = await db
		.select({
			id: downloadQueue.id,
			title: downloadQueue.title,
			status: downloadQueue.status,
			progress: downloadQueue.progress
		})
		.from(downloadQueue)
		.where(
			and(
				eq(downloadQueue.movieId, id),
				inArray(downloadQueue.status, [...ACTIVE_DOWNLOAD_STATUSES])
			)
		);

	const queueItem: QueueItemInfo | null =
		queueResults.length > 0
			? {
					id: queueResults[0].id,
					title: queueResults[0].title,
					status: queueResults[0].status ?? 'queued',
					progress: queueResults[0].progress ? parseFloat(queueResults[0].progress) : null
				}
			: null;

	let collection: CollectionInfo | null = null;
	if (movie.tmdbCollectionId) {
		const [tmdbCollection, libraryMembers] = await Promise.all([
			tmdb.getCollection(movie.tmdbCollectionId).catch((err) => {
				logger.warn(
					{
						collectionId: movie.tmdbCollectionId,
						error: err instanceof Error ? err.message : String(err)
					},
					'[LibraryMovie] Failed to fetch TMDB collection'
				);
				return null;
			}),
			db
				.select({
					id: movies.id,
					tmdbId: movies.tmdbId,
					hasFile: movies.hasFile
				})
				.from(movies)
				.where(eq(movies.tmdbCollectionId, movie.tmdbCollectionId))
		]);

		if (tmdbCollection) {
			const libraryByTmdbId = new Map(libraryMembers.map((m) => [m.tmdbId, m]));

			const libraryMovieIds = libraryMembers.map((m) => m.id);
			const subtitleMovieIds =
				libraryMovieIds.length > 0
					? new Set(
							(
								await db
									.selectDistinct({ movieId: subtitles.movieId })
									.from(subtitles)
									.where(inArray(subtitles.movieId, libraryMovieIds))
							).map((r) => r.movieId)
						)
					: new Set<string>();

			const parts: CollectionPart[] = (tmdbCollection.parts ?? []).map((part) => {
				const lib = libraryByTmdbId.get(part.id);
				return {
					tmdbId: part.id,
					title: part.title,
					year: part.release_date ? new Date(part.release_date).getFullYear() : null,
					posterPath: part.poster_path,
					releaseDate: part.release_date ?? null,
					inLibrary: !!lib,
					movieId: lib?.id ?? null,
					hasFile: lib?.hasFile ?? null,
					hasSubtitles: lib ? subtitleMovieIds.has(lib.id) : false
				};
			});
			collection = {
				tmdbId: tmdbCollection.id,
				name: tmdbCollection.name,
				posterPath: tmdbCollection.poster_path,
				backdropPath: tmdbCollection.backdrop_path,
				parts
			};
		}
	}

	const isSearching = isMovieSearching(id);
	const providerConfig = await getMetadataProviderConfig();
	const configuredMetadataProviders = {
		anilist: providerConfig.animeEnrichmentEnabled,
		mal: providerConfig.animeEnrichmentEnabled
	};

	// AniList/Jikan(MAL) enrichment is NOT looked up here. It used to be
	// (first awaited directly, then returned as an unawaited streamed
	// promise), but even streamed it still visibly delayed first paint in
	// practice - something between this app and the browser (proxy, adapter,
	// or SvelteKit's own streaming semantics) wasn't actually deferring it
	// the way the "don't await" pattern assumes. Moved to a dedicated
	// endpoint (/api/library/movies/[id]/anime-refs) that the client calls
	// after the page has already rendered - see +page.svelte. This page only
	// ever shows whatever provider refs are already stored.
	const existingMovieProviderRefs =
		(movieWithFiles.providerRefs as Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null) ??
		undefined;
	movieWithFiles.providerRefs = existingMovieProviderRefs ?? {};

	const librarySlug = movie.libraryIsDefault ? null : (movie.librarySlug ?? null);
	const libraryName = movie.libraryName ?? null;

	const delayProfiles = await delayProfileService.getProfiles();

	return {
		movie: movieWithFiles,
		librarySlug,
		libraryName,
		tmdbDetails,
		qualityProfiles: allQualityProfiles,
		delayProfiles,
		rootFolders: folders,
		queueItem,
		isSearching,
		configuredMetadataProviders,
		collection,
		subtitleStatus,
		effectiveLanguageProfile,
		effectiveSubtitleRequirements,
		languageProfiles,
		preferOriginalTitleDefault
	};
};

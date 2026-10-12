import type { RequestHandler } from './$types.js';
import { stat } from 'node:fs/promises';
import { join, resolve, normalize } from 'node:path';
import { db } from '#lib/server/db/index.js';
import {
	downloadHistory,
	downloadQueue,
	movies,
	movieFiles,
	rootFolders,
	subtitles
} from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { mediaInfoService } from '#lib/server/library/index.js';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { searchSubtitlesForNewMedia } from '#lib/server/subtitles/services/SubtitleImportService.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { monitoringSearchService } from '#lib/server/monitoring/search/MonitoringSearchService.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { deleteAllAlternateTitles } from '#lib/server/services/index.js';
import { deleteDirectoryWithinRoot } from '#lib/server/filesystem/delete-helpers.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { tmdb } from '#lib/server/tmdb.js';
import { movieUpdateSchema } from '#lib/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { upsertQueueTombstoneFromQueueItem } from '#lib/server/downloadClients/monitoring/QueueTombstoneService.js';
import {
	validateRootFolder,
	getAnimeSubtypeEnforcement
} from '#lib/server/library/LibraryAddService.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { mediaMoveService } from '#lib/server/library/MediaMoveService.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { getLibraryScheduler } from '#lib/server/library/library-scheduler.js';
import { getMetadataProviderConfig } from '#lib/server/metadata/provider-settings.js';
import { resolveMissingAnimeProviderRefs } from '#lib/server/metadata/provider-ref-resolver.js';
import { persistLinkedProviderTitleVariants } from '#lib/server/metadata/provider-resolution.js';
import { importService } from '#lib/server/downloadClients/import/index.js';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import { redundantFileIds } from '#lib/server/quality/buckets.js';
import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import {
	refreshMovieMetadata,
	metadataLanguageToLegacy,
	warnLegacyMetadataLanguage
} from '#lib/server/metadata/metadata-refresh.js';

function isAnimeMovieSignal(input: {
	rootFolderPath: string | null;
	genres: string[] | null;
	title: string;
}): boolean {
	const path = (input.rootFolderPath ?? '').toLowerCase();
	if (path.includes('/anime/')) return true;
	const genres = input.genres ?? [];
	if (genres.some((genre) => genre.toLowerCase() === 'animation')) return true;
	return /\banime\b/i.test(input.title);
}

/**
 * GET /api/library/movies/[id]
 * Get a specific movie with full details
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const [movie] = await db
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
				languageProfileId: movies.languageProfileId,
				monitored: movies.monitored,
				minimumAvailability: movies.minimumAvailability,
				added: movies.added,
				hasFile: movies.hasFile,
				wantsSubtitles: movies.wantsSubtitles,
				releaseDate: movies.releaseDate,
				digitalReleaseDate: movies.digitalReleaseDate,
				physicalReleaseDate: movies.physicalReleaseDate,
				availabilityDelay: movies.availabilityDelay,
				metadataLanguageMode: movies.metadataLanguageMode,
				metadataLanguageValue: movies.metadataLanguageValue,
				preferOriginalTitle: movies.preferOriginalTitle
			})
			.from(movies)
			.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
			.where(eq(movies.id, params.id));

		if (!movie) {
			return Response.json({ success: false, error: 'Movie not found' }, { status: 404 });
		}

		const profileService = getLanguageProfileService();
		const [
			files,
			existingSubtitles,
			subtitleStatus,
			effectiveLanguageProfile,
			effectiveSubtitleRequirements,
			releaseInfo
		] = await Promise.all([
			db.select().from(movieFiles).where(eq(movieFiles.movieId, movie.id)),
			db.select().from(subtitles).where(eq(subtitles.movieId, movie.id)),
			profileService.getMovieSubtitleStatus(movie.id),
			profileService.getEffectiveProfileForMovie(movie.id),
			profileService.getEffectiveSubtitleRequirements({ movieId: movie.id }),
			tmdb.getMovieReleaseInfo(movie.tmdbId).catch((err) => {
				logger.warn(
					{
						movieId: movie.id,
						tmdbId: movie.tmdbId,
						error: err instanceof Error ? err.message : String(err)
					},
					'[API] Failed to fetch movie release info'
				);
				return null;
			})
		]);
		const providerConfig = await getMetadataProviderConfig();
		const enrichedProviderRefs = await resolveMissingAnimeProviderRefs({
			title: movie.title,
			aliases: [movie.originalTitle ?? ''],
			year: movie.year,
			isAnime: isAnimeMovieSignal({
				rootFolderPath: movie.rootFolderPath ?? null,
				genres: (movie.genres as string[] | null) ?? null,
				title: movie.title
			}),
			configured: {
				anilist: providerConfig.animeEnrichmentEnabled,
				mal: providerConfig.animeEnrichmentEnabled
			},
			existingRefs:
				(movie.providerRefs as Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null) ??
				undefined
		});
		return Response.json({
			success: true,
			movie: {
				...movie,
				// Legacy view derived from the v2 pair (kept one release).
				metadataLanguage: metadataLanguageToLegacy(
					movie.metadataLanguageMode,
					movie.metadataLanguageValue
				),
				providerRefs: enrichedProviderRefs,
				tmdbStatus: releaseInfo?.status ?? null,
				releaseDate: releaseInfo?.release_date ?? null,
				files: files.map((f) => ({
					id: f.id,
					relativePath: f.relativePath,
					size: f.size,
					sizeFormatted: mediaInfoService.constructor.prototype.constructor.formatFileSize
						? MediaInfoService.formatFileSize(f.size ?? undefined)
						: undefined,
					dateAdded: f.dateAdded,
					quality: f.quality,
					mediaInfo: f.mediaInfo,
					releaseGroup: f.releaseGroup,
					edition: f.edition
				})),
				subtitles: existingSubtitles.map((s) => ({
					id: s.id,
					language: s.language,
					relativePath: s.relativePath,
					isForced: s.isForced,
					isHearingImpaired: s.isHearingImpaired,
					format: s.format,
					matchScore: s.matchScore,
					providerId: s.providerId,
					dateAdded: s.dateAdded,
					wasSynced: s.wasSynced,
					syncOffset: s.syncOffset
				})),
				subtitleStatus: {
					satisfied: subtitleStatus.satisfied,
					missing: subtitleStatus.missing,
					existing: subtitleStatus.existing
				},
				// The profile governing this movie plus where it was resolved
				// from (movie override > library default > instance default).
				effectiveLanguageProfile: effectiveLanguageProfile ?? null,
				// The subtitle requirements in force (item override or profile
				// chain) with their resolution source.
				effectiveSubtitleRequirements: effectiveSubtitleRequirements ?? null
			}
		});
	} catch (error) {
		logger.error('[API] Error fetching movie', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch movie'
			},
			{ status: 500 }
		);
	}
};

/**
 * PATCH /api/library/movies/[id]
 * Update movie settings (monitored, quality profile, etc.)
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = await parseBody(request, movieUpdateSchema);
	const {
		monitored,
		scoringProfileId,
		desiredQualities,
		minimumAvailability,
		availabilityDelay,
		providerRefs,
		rootFolderId,
		moveFilesOnRootChange,
		removeUnwantedFiles,
		wantsSubtitles,
		languageProfileId,
		subtitleRequirementsOverride,
		delayProfileId,
		folderPath,
		tmdbCollectionId,
		collectionName,
		metadataLanguageMode,
		metadataLanguageValue,
		metadataLanguage,
		preferOriginalTitle
	} = body;

	// Capture current state before update (for subtitle trigger detection)
	const [currentMovie] = await db
		.select({
			tmdbId: movies.tmdbId,
			title: movies.title,
			path: movies.path,
			rootFolderId: movies.rootFolderId,
			scoringProfileId: movies.scoringProfileId,
			desiredQualities: movies.desiredQualities,
			wantsSubtitles: movies.wantsSubtitles,
			languageProfileId: movies.languageProfileId,
			subtitleRequirementsOverride: movies.subtitleRequirementsOverride,
			hasFile: movies.hasFile,
			metadataLanguageMode: movies.metadataLanguageMode,
			metadataLanguageValue: movies.metadataLanguageValue
		})
		.from(movies)
		.where(eq(movies.id, params.id));

	const updateData: Record<string, unknown> = {};
	// Track fields applied outside updateData (via service calls) so the
	// "no valid fields" guard below stays accurate.
	let appliedSideEffectFields = 0;
	let moveRequest:
		| {
				mediaId: string;
				mediaTitle: string;
				relativePath: string;
				sourceRootFolderId: string;
				destinationRootFolderId: string;
		  }
		| undefined;

	if (typeof monitored === 'boolean') {
		updateData.monitored = monitored;
	}
	if (scoringProfileId !== undefined) {
		updateData.scoringProfileId = scoringProfileId;
	}
	if (desiredQualities !== undefined) {
		updateData.desiredQualities = desiredQualities;
	}
	if (delayProfileId !== undefined) {
		updateData.delayProfileId = delayProfileId;
	}
	if (minimumAvailability) {
		updateData.minimumAvailability = minimumAvailability;
	}
	if (availabilityDelay !== undefined) {
		updateData.availabilityDelay = availabilityDelay;
	}
	if (providerRefs !== undefined) {
		updateData.providerRefs = providerRefs;
	}
	if (rootFolderId !== undefined) {
		const nextRootFolderId = typeof rootFolderId === 'string' ? rootFolderId.trim() : '';
		const currentRootFolderId = currentMovie?.rootFolderId ?? null;
		if (!nextRootFolderId) {
			return Response.json(
				{
					success: false,
					error: 'Root folder is required and cannot be unset after adding media.'
				},
				{ status: 400 }
			);
		}

		// Only validate/apply when reassignment is requested.
		if (nextRootFolderId !== currentRootFolderId) {
			const hasExistingFiles = currentMovie?.hasFile === true;
			const canMoveFromCurrentRoot = Boolean(currentRootFolderId);
			if (hasExistingFiles && canMoveFromCurrentRoot && moveFilesOnRootChange !== true) {
				return Response.json(
					{
						success: false,
						error:
							'This movie already has files. Enable "Move existing files to new root folder" to change its root folder.'
					},
					{ status: 400 }
				);
			}

			const shouldMoveFiles =
				moveFilesOnRootChange === true &&
				hasExistingFiles &&
				Boolean(currentMovie?.path) &&
				canMoveFromCurrentRoot;

			const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();
			let isAnimeMedia = false;
			if (enforceAnimeSubtype && currentMovie) {
				const movieDetails = await tmdb.getMovie(currentMovie.tmdbId);
				isAnimeMedia = isLikelyAnimeMedia({
					genres: movieDetails.genres,
					originalLanguage: movieDetails.original_language,
					originCountries: movieDetails.production_countries?.map((country) => country.iso_3166_1),
					productionCountries: movieDetails.production_countries,
					title: movieDetails.title,
					originalTitle: movieDetails.original_title
				});
			}

			await validateRootFolder(nextRootFolderId, 'movie', {
				requireWritable: shouldMoveFiles,
				enforceAnimeSubtype,
				isAnimeMedia,
				mediaTitle: currentMovie?.title
			});

			if (shouldMoveFiles && currentRootFolderId && currentMovie?.path) {
				moveRequest = {
					mediaId: params.id,
					mediaTitle: currentMovie.title,
					relativePath: currentMovie.path,
					sourceRootFolderId: currentRootFolderId,
					destinationRootFolderId: nextRootFolderId
				};
			} else {
				// Recovery path: if files exist but current root folder is missing, re-link directly.
				const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
					nextRootFolderId,
					'movie'
				);
				updateData.rootFolderId = nextRootFolderId;
				updateData.libraryId = owningLibrary.id;
			}
		}
	}
	if (typeof wantsSubtitles === 'boolean') {
		updateData.wantsSubtitles = wantsSubtitles;
	}
	// Per-item subtitle requirement override: validated list or null to clear
	// (inherit from the profile chain). Replaces only the requirement list.
	if (subtitleRequirementsOverride !== undefined) {
		updateData.subtitleRequirementsOverride = subtitleRequirementsOverride;
		appliedSideEffectFields++;
	}
	// Language profile override: a string must reference an existing profile
	// and is applied through the service; null clears the override so the
	// movie inherits (library default → instance default).
	if (languageProfileId !== undefined) {
		const profileService = getLanguageProfileService();
		if (languageProfileId !== null) {
			const profile = await profileService.getProfile(languageProfileId);
			if (!profile) {
				return Response.json(
					{ success: false, error: `Language profile not found: ${languageProfileId}` },
					{ status: 400 }
				);
			}
		}
		await profileService.assignToMovie(params.id, languageProfileId);
		appliedSideEffectFields++;
	}
	if (folderPath !== undefined) {
		const trimmed = folderPath.trim();
		if (currentMovie?.rootFolderId) {
			const [rootFolder] = await db
				.select({ path: rootFolders.path })
				.from(rootFolders)
				.where(eq(rootFolders.id, currentMovie.rootFolderId))
				.limit(1);
			if (!rootFolder) {
				return Response.json({ success: false, error: 'Root folder not found' }, { status: 400 });
			}
			const resolved = normalize(join(rootFolder.path, trimmed));
			if (!resolved.startsWith(normalize(rootFolder.path) + '/')) {
				return Response.json(
					{ success: false, error: 'Folder must be within the root folder' },
					{ status: 400 }
				);
			}
			try {
				await stat(resolved);
			} catch {
				return Response.json(
					{ success: false, error: `Folder does not exist on disk: ${resolve(resolved)}` },
					{ status: 400 }
				);
			}
		}
		updateData.path = trimmed;
	}

	if (tmdbCollectionId !== undefined) {
		updateData.tmdbCollectionId = tmdbCollectionId;
	}
	if (collectionName !== undefined) {
		updateData.collectionName = collectionName;
	}
	// Metadata language override (v2 pair). The update schema maps the
	// deprecated single-string form onto metadataLanguageMode/Value.
	const metadataLanguageProvided =
		metadataLanguageMode !== undefined ||
		metadataLanguageValue !== undefined ||
		metadataLanguage !== undefined;
	const nextMetadataLanguageMode = metadataLanguageProvided
		? (metadataLanguageMode ?? 'inherit')
		: null;
	const nextMetadataLanguageValue =
		nextMetadataLanguageMode === 'explicit' ? (metadataLanguageValue ?? null) : null;
	if (metadataLanguageProvided) {
		if (metadataLanguage !== undefined) {
			warnLegacyMetadataLanguage('PATCH /api/library/movies/[id]');
		}
		updateData.metadataLanguageMode = nextMetadataLanguageMode;
		updateData.metadataLanguageValue = nextMetadataLanguageValue;
	}
	if (preferOriginalTitle === null || typeof preferOriginalTitle === 'boolean') {
		updateData.preferOriginalTitle = preferOriginalTitle;
	}

	if (Object.keys(updateData).length === 0 && !moveRequest && appliedSideEffectFields === 0) {
		return Response.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
	}

	if (Object.keys(updateData).length > 0) {
		await db.update(movies).set(updateData).where(eq(movies.id, params.id));
	}

	// Manual anime provider link: fetch the linked AniList/MAL entries and
	// persist their title variants as alternate titles (idempotent). Runs in
	// the background — external provider latency must not stall the PATCH.
	if (providerRefs?.anilist || providerRefs?.mal) {
		persistLinkedProviderTitleVariants('movie', params.id, providerRefs).catch((err) => {
			logger.warn(
				{ movieId: params.id, err },
				'[API] Failed to persist linked provider title variants'
			);
		});
	}

	// Refresh metadata from TMDB when language override changes
	const languageChanged =
		metadataLanguageProvided &&
		(nextMetadataLanguageMode !== (currentMovie?.metadataLanguageMode ?? null) ||
			nextMetadataLanguageValue !== (currentMovie?.metadataLanguageValue ?? null));
	if (languageChanged) {
		refreshMovieMetadata(params.id).catch((err) => {
			logger.error(
				{ movieId: params.id, err },
				'[API] Background metadata refresh on language change failed'
			);
		});
	}

	// Opt-in removal of now-redundant quality tiers when desiredQualities shrank.
	// The redundant set is recomputed SERVER-side authoritatively (never trust
	// the client): load current files, resolve effective buckets against the
	// movie's scoring profile, then delete via the gold-standard delete path.
	let removedCount = 0;
	const reconcileFailures: string[] = [];
	if (removeUnwantedFiles === true) {
		try {
			const reconcileDesired =
				desiredQualities !== undefined
					? desiredQualities
					: (currentMovie?.desiredQualities ?? null);
			const reconcileProfileId =
				scoringProfileId !== undefined
					? scoringProfileId
					: (currentMovie?.scoringProfileId ?? null);

			const { effective: reconcileEffective } = await resolveMovieMultiQuality(
				reconcileDesired,
				reconcileProfileId
			);

			const existingMovieFiles = await db
				.select({
					id: movieFiles.id,
					relativePath: movieFiles.relativePath,
					quality: movieFiles.quality,
					size: movieFiles.size
				})
				.from(movieFiles)
				.where(eq(movieFiles.movieId, params.id));

			const redundantIds = redundantFileIds(existingMovieFiles, reconcileEffective);
			if (redundantIds.length > 0) {
				const fileManagement = await getFileManagementSettings();
				for (const redundantId of redundantIds) {
					const deleteResult = await importService.deleteMovieFile(
						redundantId,
						params.id,
						fileManagement.recycleEnabled
					);
					if (deleteResult.success) {
						removedCount++;
					} else {
						reconcileFailures.push(deleteResult.error ?? 'Unknown error');
					}
				}
				logger.info(
					{
						movieId: params.id,
						attempted: redundantIds.length,
						removed: removedCount,
						failed: reconcileFailures.length,
						recycleEnabled: fileManagement.recycleEnabled
					},
					'[API] Removed redundant quality files on desiredQualities change'
				);
				if (reconcileFailures.length > 0) {
					logger.warn(
						{
							movieId: params.id,
							failures: reconcileFailures
						},
						'[API] Some redundant quality file deletions failed'
					);
				}
			}
		} catch (error) {
			logger.error(
				{
					movieId: params.id,
					err: error instanceof Error ? error : undefined
				},
				'[API] Failed to reconcile redundant quality files'
			);
			return Response.json(
				{
					success: false,
					error: error instanceof Error ? error.message : 'Failed to remove unwanted files'
				},
				{ status: 500 }
			);
		}
	}

	let moveTask:
		| {
				taskId: string;
				historyId: string;
		  }
		| undefined;
	if (moveRequest) {
		moveTask = await mediaMoveService.enqueueMove({
			mediaType: 'movie',
			mediaId: moveRequest.mediaId,
			mediaTitle: moveRequest.mediaTitle,
			relativePath: moveRequest.relativePath,
			sourceRootFolderId: moveRequest.sourceRootFolderId,
			destinationRootFolderId: moveRequest.destinationRootFolderId
		});
	}

	const profileChanged =
		scoringProfileId !== undefined && scoringProfileId !== currentMovie?.scoringProfileId;

	// If scoring profile changed, trigger upgrade search for existing files
	if (profileChanged && currentMovie?.hasFile) {
		monitoringSearchService
			.searchForUpgrades({
				movieIds: [params.id],
				cutoffUnmetOnly: false,
				ignoreCooldown: true
			})
			.catch((err) => {
				logger.error(
					{
						movieId: params.id,
						error: err instanceof Error ? err.message : 'Unknown error'
					},
					'[API] Background upgrade search on profile change failed'
				);
			});

		logger.info(
			{
				movieId: params.id,
				newProfile: scoringProfileId
			},
			'[API] Triggered upgrade search on profile change for movie'
		);
	}

	// Check if subtitle monitoring was just enabled, or the requirement
	// override changed while the gate is on. Requirements may come from the
	// profile chain (library/instance default), so the gate alone enables.
	if (currentMovie?.hasFile) {
		const wasEnabled = currentMovie.wantsSubtitles === true;
		const newWantsSubtitles = wantsSubtitles ?? currentMovie.wantsSubtitles;
		const isNowEnabled = newWantsSubtitles === true;
		const overrideChanged =
			subtitleRequirementsOverride !== undefined &&
			JSON.stringify(subtitleRequirementsOverride) !==
				JSON.stringify(currentMovie.subtitleRequirementsOverride ?? null);

		// Trigger subtitle search if just enabled (wasn't before, is now) or
		// the requirements changed while enabled.
		if (isNowEnabled && (!wasEnabled || overrideChanged)) {
			const settings = await monitoringScheduler.getSettings();
			if (settings.subtitleSearchOnImportEnabled) {
				logger.info(
					{
						movieId: params.id
					},
					'[API] Subtitle monitoring enabled for movie, triggering search'
				);
				// Fire-and-forget: don't await
				searchSubtitlesForNewMedia('movie', params.id).catch((err) => {
					logger.warn(
						{
							movieId: params.id,
							error: err instanceof Error ? err.message : String(err)
						},
						'[API] Background subtitle search failed'
					);
				});
			}
		}
	}

	libraryMediaEvents.emitMovieUpdated(params.id);

	// When the folder path was corrected, queue a rescan of the root folder so
	// the scanner re-links files at the new path without any manual intervention.
	if (folderPath !== undefined && currentMovie?.rootFolderId) {
		getLibraryScheduler().queueFolderScan(currentMovie.rootFolderId);
	}

	const failedCount = reconcileFailures.length;
	return Response.json({
		success: true,
		moveQueued: Boolean(moveTask),
		moveTaskId: moveTask?.taskId,
		moveTaskHistoryId: moveTask?.historyId,
		removedCount,
		...(failedCount > 0
			? {
					failedCount,
					warning: `Removed ${removedCount}, ${failedCount} failed`
				}
			: {})
	});
};

// Alias PUT to PATCH for convenience
export const PUT: RequestHandler = PATCH;

/**
 * DELETE /api/library/movies/[id]
 * Delete files for a movie (keeps metadata, marks as missing)
 * With removeFromLibrary=true, removes the movie entirely from the database
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
	try {
		const deleteFiles = url.searchParams.get('deleteFiles') === 'true';
		const removeFromLibrary = url.searchParams.get('removeFromLibrary') === 'true';

		// Get movie with root folder info
		const [movie] = await db
			.select({
				id: movies.id,
				path: movies.path,
				hasFile: movies.hasFile,
				rootFolderPath: rootFolders.path,
				rootFolderReadOnly: rootFolders.readOnly
			})
			.from(movies)
			.leftJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
			.where(eq(movies.id, params.id));

		if (!movie) {
			return Response.json({ success: false, error: 'Movie not found' }, { status: 404 });
		}

		// Get all files for this movie
		const files = await db.select().from(movieFiles).where(eq(movieFiles.movieId, params.id));

		// Only require files if not removing from library entirely. An active
		// download counts: its files live in the client, not in movieFiles yet.
		const hasActiveDownloads =
			deleteFiles &&
			!removeFromLibrary &&
			files.length === 0 &&
			(
				await db
					.select({ id: downloadQueue.id })
					.from(downloadQueue)
					.where(eq(downloadQueue.movieId, params.id))
					.limit(1)
			).length > 0;
		if (files.length === 0 && !removeFromLibrary && !hasActiveDownloads) {
			return Response.json(
				{ success: false, error: 'Movie has no files to delete' },
				{ status: 400 }
			);
		}

		// Block file deletion from read-only folders
		if (deleteFiles && movie.rootFolderReadOnly) {
			return Response.json(
				{ success: false, error: 'Cannot delete files from read-only folder' },
				{ status: 400 }
			);
		}

		// Delete files from disk if requested
		if (deleteFiles && movie.rootFolderPath && movie.path) {
			const movieFolder = await deleteDirectoryWithinRoot(movie.rootFolderPath, movie.path);
			logger.debug({ movieFolder }, '[API] Removed movie folder and all contents');
		}

		// Delete movie file records from database
		if (files.length > 0) {
			await db.delete(movieFiles).where(eq(movieFiles.movieId, params.id));
		}

		// Drop client entries when deleting files — a copy seeding in the
		// client must go with the files. A queue row whose client entry was
		// removed is dropped with it (tombstoned); other queue tracking is
		// only dropped when removing from the library.
		if (deleteFiles || removeFromLibrary) {
			const activeQueueItems = await db
				.select()
				.from(downloadQueue)
				.where(eq(downloadQueue.movieId, params.id));

			for (const queueItem of activeQueueItems) {
				let clientEntryRemoved = false;
				if (deleteFiles && queueItem.downloadClientId) {
					try {
						const isTorrent = queueItem.protocol === 'torrent';
						const clientDownloadId = isTorrent
							? queueItem.infoHash || queueItem.downloadId
							: queueItem.downloadId || queueItem.infoHash;
						if (clientDownloadId) {
							const clientInstance = await getDownloadClientManager().getClientInstance(
								queueItem.downloadClientId
							);
							if (clientInstance) {
								await clientInstance.removeDownload(clientDownloadId, true);
								clientEntryRemoved = true;
							}
						}
					} catch (err) {
						logger.warn(
							{
								queueItemId: queueItem.id,
								error: err instanceof Error ? err.message : 'Unknown'
							},
							'[API] Failed to remove download from client'
						);
					}
				}
				if (removeFromLibrary || clientEntryRemoved) {
					// Delete queue record — cancel the acquisition intent first so the
					// slot is released rather than leaking until restart. A removed
					// client entry is tombstoned so the monitor treats the
					// disappearance as intentional, not a failure to recover.
					if (clientEntryRemoved && !removeFromLibrary) {
						try {
							await upsertQueueTombstoneFromQueueItem(queueItem, 'library_files_deleted');
						} catch (tombstoneError) {
							logger.warn(
								{
									queueItemId: queueItem.id,
									error: tombstoneError instanceof Error ? tombstoneError.message : 'Unknown'
								},
								'[API] Failed to upsert queue tombstone'
							);
						}
					}
					acquisitionService.cancelByQueueId(
						queueItem.id,
						removeFromLibrary ? 'media removed from library' : 'media files deleted'
					);
					await db.delete(downloadQueue).where(eq(downloadQueue.id, queueItem.id));
				}
			}
		}

		if (removeFromLibrary) {
			// Preserve activity audit trail after media row is deleted (FKs become null on delete)
			await db
				.update(downloadHistory)
				.set({ status: 'removed', statusReason: null })
				.where(eq(downloadHistory.movieId, params.id));

			// Delete alternate titles (not cascaded automatically)
			await deleteAllAlternateTitles('movie', params.id);

			// Delete the movie from database - CASCADE will handle:
			// - subtitles, downloadQueue, pendingReleases, blocklist, etc.
			await db.delete(movies).where(eq(movies.id, params.id));
			libraryMediaEvents.emitMovieUpdated(params.id);

			logger.info({ movieId: params.id }, '[API] Removed movie from library');
			return Response.json({ success: true, removed: true });
		} else {
			// Update movie to show as missing
			await db
				.update(movies)
				.set({ hasFile: false, lastSearchTime: null })
				.where(eq(movies.id, params.id));
			libraryMediaEvents.emitMovieUpdated(params.id);

			// Note: Movie metadata is kept - it will show as "missing"
			return Response.json({ success: true });
		}
	} catch (error) {
		logger.error('[API] Error deleting movie files', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete movie files'
			},
			{ status: 500 }
		);
	}
};

// Import for static method access
import { MediaInfoService } from '#lib/server/library/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryMovieByIdApi', logDomain: 'scans' });

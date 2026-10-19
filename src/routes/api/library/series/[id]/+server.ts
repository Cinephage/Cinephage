import type { RequestHandler } from './$types.js';
import { stat } from 'node:fs/promises';
import { join, resolve, normalize } from 'node:path';
import { db } from '#lib/server/db/index.js';
import {
	series,
	seasons,
	episodes,
	episodeFiles,
	downloadHistory,
	downloadQueue,
	rootFolders,
	subtitles
} from '#lib/server/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { deleteDirectoryWithinRoot } from '#lib/server/filesystem/delete-helpers.js';
import { todayDateString } from '#lib/utils/format.js';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { searchSubtitlesForMediaBatch } from '#lib/server/subtitles/services/SubtitleImportService.js';
import { searchOnAdd } from '#lib/server/library/searchOnAdd.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { monitoringSearchService } from '#lib/server/monitoring/search/MonitoringSearchService.js';
import { deleteAllAlternateTitles } from '#lib/server/services/index.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import {
	validateRootFolder,
	getAnimeSubtypeEnforcement
} from '#lib/server/library/LibraryAddService.js';
import {
	deleteAllSeasonsAndEpisodes,
	buildSeasonsAndEpisodesFromGroup,
	getEffectiveEpisodeGroup
} from '#lib/server/metadata/EpisodeGroupService.js';
import { mediaMoveService } from '#lib/server/library/MediaMoveService.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { getLibraryScheduler } from '#lib/server/library/library-scheduler.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { seriesUpdateSchema } from '#lib/validation/schemas.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { tmdb } from '#lib/server/tmdb.js';
import { getMetadataProviderConfig } from '#lib/server/metadata/provider-settings.js';
import { resolveMissingAnimeProviderRefs } from '#lib/server/metadata/provider-ref-resolver.js';
import { persistLinkedProviderTitleVariants } from '#lib/server/metadata/provider-resolution.js';
import {
	refreshSeriesMetadata,
	metadataLanguageToLegacy,
	warnLegacyMetadataLanguage
} from '#lib/server/metadata/metadata-refresh.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibrarySeriesByIdApi', logDomain: 'scans' });

/**
 * GET /api/library/series/[id]
 * Get a specific series with seasons and episodes
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const [seriesItem] = await db
			.select({
				id: series.id,
				tmdbId: series.tmdbId,
				tvdbId: series.tvdbId,
				imdbId: series.imdbId,
				title: series.title,
				originalTitle: series.originalTitle,
				year: series.year,
				overview: series.overview,
				posterPath: series.posterPath,
				backdropPath: series.backdropPath,
				status: series.status,
				network: series.network,
				genres: series.genres,
				path: series.path,
				rootFolderId: series.rootFolderId,
				rootFolderPath: rootFolders.path,
				scoringProfileId: series.scoringProfileId,
				languageProfileId: series.languageProfileId,
				monitored: series.monitored,
				seasonFolder: series.seasonFolder,
				seriesType: series.seriesType,
				providerRefs: series.providerRefs,
				added: series.added,
				episodeCount: series.episodeCount,
				episodeFileCount: series.episodeFileCount,
				wantsSubtitles: series.wantsSubtitles,
				episodeGroupId: series.episodeGroupId,
				metadataLanguageMode: series.metadataLanguageMode,
				metadataLanguageValue: series.metadataLanguageValue,
				preferOriginalTitle: series.preferOriginalTitle
			})
			.from(series)
			.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
			.where(eq(series.id, params.id));

		if (!seriesItem) {
			return Response.json({ success: false, error: 'Series not found' }, { status: 404 });
		}

		// Get seasons
		const allSeasons = await db
			.select()
			.from(seasons)
			.where(eq(seasons.seriesId, params.id))
			.orderBy(seasons.seasonNumber);

		// Get episodes
		const allEpisodes = await db
			.select()
			.from(episodes)
			.where(eq(episodes.seriesId, params.id))
			.orderBy(episodes.seasonNumber, episodes.episodeNumber);

		// Get episode files
		const allFiles = await db
			.select()
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, params.id));

		// Match the page-load/SSE behavior: build a stable episode -> file map.
		// Using allFiles.find(...) can over-assign stale pack rows during client-side refreshes.
		const episodeIdToFile = new Map<string, (typeof allFiles)[number]>();
		for (const file of allFiles) {
			const episodeIds = file.episodeIds as string[] | null;
			for (const episodeId of episodeIds ?? []) {
				episodeIdToFile.set(episodeId, file);
			}
		}

		// Get subtitles for all episodes in this series
		const episodeIds = allEpisodes.map((ep) => ep.id);
		const allSubtitles =
			episodeIds.length > 0
				? await db.select().from(subtitles).where(inArray(subtitles.episodeId, episodeIds))
				: [];

		// Group subtitles by episode ID
		const subtitlesByEpisode = new Map<string, typeof allSubtitles>();
		for (const sub of allSubtitles) {
			if (sub.episodeId) {
				const existing = subtitlesByEpisode.get(sub.episodeId) || [];
				existing.push(sub);
				subtitlesByEpisode.set(sub.episodeId, existing);
			}
		}

		// Build structured response
		const providerConfig = await getMetadataProviderConfig();
		const enrichedProviderRefs = await resolveMissingAnimeProviderRefs({
			title: seriesItem.title,
			aliases: [seriesItem.originalTitle ?? ''],
			year: seriesItem.year,
			isAnime: (seriesItem.seriesType ?? '').toLowerCase() === 'anime',
			configured: {
				anilist: providerConfig.animeEnrichmentEnabled,
				mal: providerConfig.animeEnrichmentEnabled
			},
			existingRefs:
				(seriesItem.providerRefs as Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null) ??
				undefined
		});

		const seasonsWithEpisodes = allSeasons.map((season) => ({
			...season,
			episodes: allEpisodes
				.filter((ep) => ep.seasonNumber === season.seasonNumber)
				.map((ep) => {
					const epSubtitles = subtitlesByEpisode.get(ep.id) || [];
					return {
						...ep,
						file: episodeIdToFile.get(ep.id) ?? null,
						subtitles: epSubtitles.map((s) => ({
							id: s.id,
							language: s.language,
							isForced: s.isForced,
							isHearingImpaired: s.isHearingImpaired,
							format: s.format,
							matchScore: s.matchScore,
							providerId: s.providerId,
							dateAdded: s.dateAdded,
							wasSynced: s.wasSynced,
							syncOffset: s.syncOffset
						})),
						subtitleCount: epSubtitles.length,
						subtitleLanguages: [...new Set(epSubtitles.map((s) => s.language))]
					};
				})
		}));

		// Get overall series subtitle status (episodes missing subtitles)
		const profileService = getLanguageProfileService();
		const [episodesMissingSubs, effectiveLanguageProfile, effectiveSubtitleRequirements] =
			await Promise.all([
				profileService.getSeriesEpisodesMissingSubtitles(params.id),
				profileService.getEffectiveProfileForSeries(params.id),
				profileService.getEffectiveSubtitleRequirements({ seriesId: params.id })
			]);

		return Response.json({
			success: true,
			series: {
				...seriesItem,
				// Legacy view derived from the v2 pair (kept one release).
				metadataLanguage: metadataLanguageToLegacy(
					seriesItem.metadataLanguageMode,
					seriesItem.metadataLanguageValue
				),
				providerRefs: enrichedProviderRefs,
				percentComplete:
					seriesItem.episodeCount && seriesItem.episodeCount > 0
						? Math.round(((seriesItem.episodeFileCount || 0) / seriesItem.episodeCount) * 100)
						: 0,
				seasons: seasonsWithEpisodes,
				subtitleStatus: {
					episodesMissingSubtitles: episodesMissingSubs.length,
					totalSubtitles: allSubtitles.length,
					languages: [...new Set(allSubtitles.map((s) => s.language))]
				},
				// The profile governing this series plus where it was resolved
				// from (series override > library default > instance default).
				effectiveLanguageProfile: effectiveLanguageProfile ?? null,
				effectiveSubtitleRequirements: effectiveSubtitleRequirements ?? null
			}
		});
	} catch (error) {
		logger.error('[API] Error fetching series', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch series'
			},
			{ status: 500 }
		);
	}
};

/**
 * PATCH /api/library/series/[id]
 * Update series settings
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const rawBody = await request.json();
		const parsed = seriesUpdateSchema.safeParse(rawBody);
		if (!parsed.success) {
			return Response.json(
				{ success: false, error: parsed.error.issues[0].message },
				{ status: 400 }
			);
		}
		const body = parsed.data;
		const {
			monitored,
			scoringProfileId,
			seasonFolder,
			seriesType,
			providerRefs,
			rootFolderId,
			wantsSubtitles,
			languageProfileId,
			subtitleRequirementsOverride,
			delayProfileId,
			folderPath,
			episodeGroupId,
			metadataLanguageMode,
			metadataLanguageValue,
			metadataLanguage,
			preferOriginalTitle
		} = body;
		const moveFilesOnRootChange = rawBody.moveFilesOnRootChange;

		// Get current series state BEFORE update to detect monitoring changes
		const [currentSeries] = await db
			.select({
				tmdbId: series.tmdbId,
				title: series.title,
				seriesType: series.seriesType,
				path: series.path,
				episodeFileCount: series.episodeFileCount,
				rootFolderId: series.rootFolderId,
				monitored: series.monitored,
				scoringProfileId: series.scoringProfileId,
				wantsSubtitles: series.wantsSubtitles,
				languageProfileId: series.languageProfileId,
				subtitleRequirementsOverride: series.subtitleRequirementsOverride,
				episodeGroupId: series.episodeGroupId,
				monitorSpecials: series.monitorSpecials,
				metadataLanguageMode: series.metadataLanguageMode,
				metadataLanguageValue: series.metadataLanguageValue
			})
			.from(series)
			.where(eq(series.id, params.id));

		const wasUnmonitored = currentSeries ? !currentSeries.monitored : false;
		const profileChanged =
			scoringProfileId !== undefined && scoringProfileId !== currentSeries?.scoringProfileId;
		const seriesHasFiles = (currentSeries?.episodeFileCount ?? 0) > 0;

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

		if (monitored !== undefined) {
			updateData.monitored = monitored;
		}
		if (scoringProfileId !== undefined) {
			updateData.scoringProfileId = scoringProfileId;
		}
		if (delayProfileId !== undefined) {
			updateData.delayProfileId = delayProfileId;
		}
		if (seasonFolder !== undefined) {
			updateData.seasonFolder = seasonFolder;
		}
		if (seriesType !== undefined) {
			updateData.seriesType = seriesType;
		}
		if (providerRefs !== undefined) {
			updateData.providerRefs = providerRefs;
		}
		if (rootFolderId !== undefined) {
			const nextRootFolderId = rootFolderId.trim();
			const currentRootFolderId = currentSeries?.rootFolderId ?? null;
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
				const hasExistingFiles = (currentSeries?.episodeFileCount ?? 0) > 0;
				const canMoveFromCurrentRoot = Boolean(currentRootFolderId);
				if (hasExistingFiles && canMoveFromCurrentRoot && moveFilesOnRootChange !== true) {
					return Response.json(
						{
							success: false,
							error:
								'This series already has files. Enable "Move existing files to new root folder" to change its root folder.'
						},
						{ status: 400 }
					);
				}

				const shouldMoveFiles =
					moveFilesOnRootChange === true &&
					hasExistingFiles &&
					Boolean(currentSeries?.path) &&
					canMoveFromCurrentRoot;

				const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();
				let isAnimeMedia = false;
				if (enforceAnimeSubtype && currentSeries) {
					const tvDetails = await tmdb.getTVShow(currentSeries.tmdbId);
					isAnimeMedia = isLikelyAnimeMedia({
						genres: tvDetails.genres,
						originalLanguage: tvDetails.original_language,
						originCountries: tvDetails.origin_country,
						productionCountries: tvDetails.production_countries,
						title: tvDetails.name,
						originalTitle: tvDetails.original_name
					});
				}

				await validateRootFolder(nextRootFolderId, 'tv', {
					requireWritable: shouldMoveFiles,
					enforceAnimeSubtype,
					isAnimeMedia,
					mediaTitle: currentSeries?.title
				});

				if (shouldMoveFiles && currentRootFolderId && currentSeries?.path) {
					moveRequest = {
						mediaId: params.id,
						mediaTitle: currentSeries.title,
						relativePath: currentSeries.path,
						sourceRootFolderId: currentRootFolderId,
						destinationRootFolderId: nextRootFolderId
					};
				} else {
					// Recovery path: if files exist but current root folder is missing, re-link directly.
					const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
						nextRootFolderId,
						'tv'
					);
					updateData.rootFolderId = nextRootFolderId;
					updateData.libraryId = owningLibrary.id;
				}
			}
		}
		if (wantsSubtitles !== undefined) {
			updateData.wantsSubtitles = wantsSubtitles;
		}
		// Per-item subtitle requirement override: validated list or null to
		// clear (inherit from the profile chain). Replaces only the list.
		if (subtitleRequirementsOverride !== undefined) {
			updateData.subtitleRequirementsOverride = subtitleRequirementsOverride;
			appliedSideEffectFields++;
		}
		// Language profile override: a string must reference an existing profile
		// and is applied through the service; null clears the override so the
		// series inherits (library default → instance default).
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
			await profileService.assignToSeries(params.id, languageProfileId);
			appliedSideEffectFields++;
		}
		if (folderPath !== undefined) {
			const trimmed = folderPath.trim();
			if (currentSeries?.rootFolderId) {
				// ... existing folder validation ...
				const [rootFolder] = await db
					.select({ path: rootFolders.path })
					.from(rootFolders)
					.where(eq(rootFolders.id, currentSeries.rootFolderId))
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
				warnLegacyMetadataLanguage('PATCH /api/library/series/[id]');
			}
			updateData.metadataLanguageMode = nextMetadataLanguageMode;
			updateData.metadataLanguageValue = nextMetadataLanguageValue;
		}
		if (preferOriginalTitle === null || typeof preferOriginalTitle === 'boolean') {
			updateData.preferOriginalTitle = preferOriginalTitle;
		}

		if (
			Object.keys(updateData).length === 0 &&
			!moveRequest &&
			episodeGroupId === undefined &&
			appliedSideEffectFields === 0
		) {
			return Response.json({ success: false, error: 'No valid fields to update' }, { status: 400 });
		}

		if (Object.keys(updateData).length > 0) {
			await db.update(series).set(updateData).where(eq(series.id, params.id));
		}

		// Manual anime provider link: fetch the linked AniList/MAL entries and
		// persist their title variants as alternate titles (idempotent). Runs in
		// the background — external provider latency must not stall the PATCH.
		if (providerRefs?.anilist || providerRefs?.mal) {
			persistLinkedProviderTitleVariants('series', params.id, providerRefs).catch((err) => {
				logger.warn(
					{ seriesId: params.id, err },
					'[API] Failed to persist linked provider title variants'
				);
			});
		}

		// Refresh metadata from TMDB when language override changes
		const languageChanged =
			metadataLanguageProvided &&
			(nextMetadataLanguageMode !== (currentSeries?.metadataLanguageMode ?? null) ||
				nextMetadataLanguageValue !== (currentSeries?.metadataLanguageValue ?? null));
		if (languageChanged) {
			refreshSeriesMetadata(params.id).catch((err) => {
				logger.error(
					{ seriesId: params.id, err },
					'[API] Background series metadata refresh on language change failed'
				);
			});
		}

		// Handle episode group change - requires full season/episode rebuild
		if (episodeGroupId !== undefined) {
			const currentGroupId = currentSeries?.episodeGroupId ?? null;
			const newGroupId = episodeGroupId || null;

			if (newGroupId !== (currentGroupId ?? null)) {
				logger.info(
					{
						seriesId: params.id,
						oldGroupId: currentGroupId,
						newGroupId
					},
					'Episode group changed, rebuilding seasons and episodes'
				);

				await db.update(series).set({ episodeGroupId: newGroupId }).where(eq(series.id, params.id));

				await deleteAllSeasonsAndEpisodes(params.id);

				let episodeGroup = null;
				if (newGroupId) {
					({ group: episodeGroup } = await getEffectiveEpisodeGroup(
						currentSeries.tmdbId,
						newGroupId
					));
				}

				if (episodeGroup) {
					const { seasonValues, episodeValues: groupEpisodeValues } =
						buildSeasonsAndEpisodesFromGroup(params.id, episodeGroup);

					if (seasonValues.length > 0) {
						const monitorSpecials = currentSeries?.monitorSpecials ?? false;

						if (monitorSpecials) {
							for (const sv of seasonValues) {
								if (sv.seasonNumber === 0) {
									sv.monitored = true;
								}
							}
							for (const ev of groupEpisodeValues) {
								if (ev.seasonNumber === 0) {
									ev.monitored = true;
								}
							}
						}

						const insertedSeasons = await db.insert(seasons).values(seasonValues).returning();
						const seasonIdByNumber = new Map(insertedSeasons.map((s) => [s.seasonNumber, s.id]));

						const enrichedEpisodes = groupEpisodeValues.map((ep) => ({
							...ep,
							seasonId: seasonIdByNumber.get(ep.seasonNumber!) ?? null
						}));

						if (enrichedEpisodes.length > 0) {
							await db.insert(episodes).values(enrichedEpisodes);
						}
					}
				} else {
					// Reverted to default TMDB ordering - trigger a full refresh via rescan
					// The getEffectiveEpisodeGroup with null groupId fetches from raw TMDB
					const tvDetails = await tmdb.getTVShow(currentSeries.tmdbId);

					if (tvDetails.seasons) {
						const monitorSpecials = currentSeries?.monitorSpecials ?? false;

						for (const s of tvDetails.seasons) {
							try {
								const tmdbSeason = await tmdb.getSeason(currentSeries.tmdbId, s.season_number);

								const isSpecials = s.season_number === 0;
								const seasonMonitored = !isSpecials || monitorSpecials;

								const [newSeason] = await db
									.insert(seasons)
									.values({
										seriesId: params.id,
										seasonNumber: s.season_number,
										name: tmdbSeason.name || s.name,
										overview: tmdbSeason.overview || s.overview,
										posterPath: tmdbSeason.poster_path || s.poster_path,
										airDate: tmdbSeason.air_date || s.air_date,
										episodeCount: tmdbSeason.episodes?.length ?? s.episode_count ?? 0,
										episodeFileCount: 0,
										monitored: seasonMonitored
									})
									.returning();

								if (tmdbSeason.episodes) {
									const episodeValues = tmdbSeason.episodes.map((ep) => ({
										seriesId: params.id,
										seasonId: newSeason.id,
										tmdbId: ep.id,
										seasonNumber: ep.season_number,
										episodeNumber: ep.episode_number,
										title: ep.name,
										overview: ep.overview,
										airDate: ep.air_date,
										runtime: ep.runtime,
										monitored: seasonMonitored,
										hasFile: false
									}));

									if (episodeValues.length > 0) {
										await db.insert(episodes).values(episodeValues);
									}
								}

								await new Promise((resolve) => setTimeout(resolve, 50));
							} catch {
								logger.warn(
									{ seasonNumber: s.season_number },
									'[API] Failed to fetch season during episode group revert'
								);
							}
						}
					}
				}

				// Update series stats after rebuild
				const allEpisodes = await db
					.select()
					.from(episodes)
					.where(eq(episodes.seriesId, params.id));
				const today = todayDateString();
				const isAired = (ep: typeof episodes.$inferSelect) =>
					ep.airDate && ep.airDate !== '' && ep.airDate <= today;
				const airedEpisodes = allEpisodes.filter(isAired);
				const episodeCount = airedEpisodes.length;
				const episodeFileCount = airedEpisodes.filter((e) => e.hasFile).length;

				await db
					.update(series)
					.set({ episodeCount, episodeFileCount })
					.where(eq(series.id, params.id));

				// Trigger a library rescan to re-match files
				if (currentSeries.rootFolderId) {
					getLibraryScheduler().queueFolderScan(currentSeries.rootFolderId);
				}
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
				mediaType: 'series',
				mediaId: moveRequest.mediaId,
				mediaTitle: moveRequest.mediaTitle,
				relativePath: moveRequest.relativePath,
				sourceRootFolderId: moveRequest.sourceRootFolderId,
				destinationRootFolderId: moveRequest.destinationRootFolderId
			});
		}

		// If monitoring was just enabled, check if we should trigger a search
		if (wasUnmonitored && monitored === true) {
			const settings = await monitoringScheduler.getSettings();

			if (settings.searchOnMonitorEnabled) {
				// Fire and forget - don't block the response
				searchOnAdd.searchForMissingEpisodes(params.id).catch((e: unknown) => {
					logger.error(
						{
							seriesId: params.id,
							error: e instanceof Error ? e.message : 'Unknown error'
						},
						'[API] Background search on monitor enable failed'
					);
				});

				logger.info(
					{
						seriesId: params.id
					},
					'[API] Triggered search on monitor enable for series'
				);
			}
		}

		// If scoring profile changed, trigger upgrade search for existing files
		if (profileChanged && seriesHasFiles) {
			monitoringSearchService
				.searchForUpgrades({
					seriesIds: [params.id],
					cutoffUnmetOnly: false,
					ignoreCooldown: true
				})
				.catch((err) => {
					logger.error(
						{
							seriesId: params.id,
							error: err instanceof Error ? err.message : 'Unknown error'
						},
						'[API] Background upgrade search on profile change failed'
					);
				});

			logger.info(
				{
					seriesId: params.id,
					newProfile: scoringProfileId
				},
				'[API] Triggered upgrade search on profile change for series'
			);
		}

		// Check if subtitle monitoring was just enabled, or the requirement
		// override changed while the gate is on. Requirements may come from the
		// profile chain (library/instance default), so the gate alone enables.
		if (currentSeries) {
			const wasSubtitlesEnabled = currentSeries.wantsSubtitles === true;
			const newWantsSubtitles = wantsSubtitles ?? currentSeries.wantsSubtitles;
			const isNowSubtitlesEnabled = newWantsSubtitles === true;
			const overrideChanged =
				subtitleRequirementsOverride !== undefined &&
				JSON.stringify(subtitleRequirementsOverride) !==
					JSON.stringify(currentSeries.subtitleRequirementsOverride ?? null);

			// Trigger subtitle search for all episodes with files if just
			// enabled or the requirements changed while enabled.
			if (isNowSubtitlesEnabled && (!wasSubtitlesEnabled || overrideChanged)) {
				const settings = await monitoringScheduler.getSettings();

				if (settings.subtitleSearchOnImportEnabled) {
					// Get all episodes with files
					const episodesWithFiles = await db
						.select({ id: episodes.id })
						.from(episodes)
						.where(and(eq(episodes.seriesId, params.id), eq(episodes.hasFile, true)));

					if (episodesWithFiles.length > 0) {
						logger.info(
							{
								seriesId: params.id,
								episodeCount: episodesWithFiles.length
							},
							'[API] Subtitle monitoring enabled for series, triggering search'
						);

						// Fire-and-forget: batch search all episodes
						const items = episodesWithFiles.map((ep) => ({
							mediaType: 'episode' as const,
							mediaId: ep.id
						}));

						searchSubtitlesForMediaBatch(items).catch((err) => {
							logger.warn(
								{
									seriesId: params.id,
									error: err instanceof Error ? err.message : String(err)
								},
								'[API] Background subtitle batch search failed'
							);
						});
					}
				}
			}
		}

		libraryMediaEvents.emitSeriesUpdated(params.id);

		if (folderPath !== undefined && currentSeries?.rootFolderId) {
			getLibraryScheduler().queueFolderScan(currentSeries.rootFolderId);
		}

		return Response.json({
			success: true,
			moveQueued: Boolean(moveTask),
			moveTaskId: moveTask?.taskId,
			moveTaskHistoryId: moveTask?.historyId
		});
	} catch (error) {
		logger.error('[API] Error updating series', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to update series'
			},
			{ status: 500 }
		);
	}
};

// Alias PUT to PATCH for convenience
export const PUT: RequestHandler = PATCH;

/**
 * DELETE /api/library/series/[id]
 * Delete files for a series (keeps metadata, marks episodes as missing)
 * With removeFromLibrary=true, removes the series entirely from the database
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
	try {
		const deleteFiles = url.searchParams.get('deleteFiles') === 'true';
		const removeFromLibrary = url.searchParams.get('removeFromLibrary') === 'true';

		// Get series with root folder info
		const [seriesItem] = await db
			.select({
				id: series.id,
				path: series.path,
				rootFolderPath: rootFolders.path,
				rootFolderReadOnly: rootFolders.readOnly
			})
			.from(series)
			.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
			.where(eq(series.id, params.id));

		if (!seriesItem) {
			return Response.json({ success: false, error: 'Series not found' }, { status: 404 });
		}

		// Get all episode files for this series
		const files = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, params.id));

		// Unmatch also releases client-side tracking from the Unmatched-tab
		// track/enroll flow so the torrent resurfaces in Unmatched. Real
		// grabs (including arr_push-pushed ones) and the client itself are
		// never touched - only rows explicitly stamped with `origin` qualify.
		const unmatchedRelease = acquisitionService.releaseUnmatchedQueueItems(
			{ seriesId: params.id },
			'files unmatched from library'
		);

		// Only require files if not removing from library entirely and there
		// is no client tracking to release back to Unmatched.
		if (
			files.length === 0 &&
			!removeFromLibrary &&
			unmatchedRelease.released === 0 &&
			unmatchedRelease.heldBack === 0
		) {
			return Response.json(
				{ success: false, error: 'Series has no files to delete' },
				{ status: 400 }
			);
		}

		// Block file deletion from read-only folders
		if (deleteFiles && seriesItem.rootFolderReadOnly) {
			return Response.json(
				{ success: false, error: 'Cannot delete files from read-only folder' },
				{ status: 400 }
			);
		}

		// Delete files from disk if requested
		if (deleteFiles && seriesItem.rootFolderPath && seriesItem.path) {
			const seriesFolder = await deleteDirectoryWithinRoot(
				seriesItem.rootFolderPath,
				seriesItem.path
			);
			logger.debug({ seriesFolder }, '[API] Removed series folder and all contents');
		}

		// Delete all episode file records from database
		if (files.length > 0) {
			await db.delete(episodeFiles).where(eq(episodeFiles.seriesId, params.id));
		}

		if (removeFromLibrary) {
			// Cancel active downloads from client before removing
			const activeQueueItems = await db
				.select()
				.from(downloadQueue)
				.where(eq(downloadQueue.seriesId, params.id));

			for (const queueItem of activeQueueItems) {
				if (queueItem.downloadClientId) {
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
				// Delete queue record
				acquisitionService.cancelByQueueId(queueItem.id, 'media removed from library');
				await db.delete(downloadQueue).where(eq(downloadQueue.id, queueItem.id));
			}

			// Preserve activity audit trail after media row is deleted (FKs become null on delete)
			await db
				.update(downloadHistory)
				.set({ status: 'removed', statusReason: null })
				.where(eq(downloadHistory.seriesId, params.id));

			// Delete alternate titles (not cascaded automatically)
			await deleteAllAlternateTitles('series', params.id);

			// Delete the series from database - CASCADE will handle:
			// - seasons, episodes, subtitles, downloadQueue, pendingReleases, blocklist, etc.
			await db.delete(series).where(eq(series.id, params.id));
			libraryMediaEvents.emitSeriesUpdated(params.id);

			logger.info({ seriesId: params.id }, '[API] Removed series from library');
			return Response.json({ success: true, removed: true });
		} else {
			// Update all episodes in this series to hasFile=false
			await db
				.update(episodes)
				.set({ hasFile: false, lastSearchTime: null })
				.where(eq(episodes.seriesId, params.id));

			// Update all seasons' episode file count to 0
			await db.update(seasons).set({ episodeFileCount: 0 }).where(eq(seasons.seriesId, params.id));

			// Update series episode file count
			await db.update(series).set({ episodeFileCount: 0 }).where(eq(series.id, params.id));

			// Unmatched-flow queue rows were already released above.
			libraryMediaEvents.emitSeriesUpdated(params.id);

			// Note: Series, season, and episode metadata is kept - episodes will show as "missing"
			return Response.json({ success: true });
		}
	} catch (error) {
		logger.error('[API] Error deleting series files', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete series files'
			},
			{ status: 500 }
		);
	}
};

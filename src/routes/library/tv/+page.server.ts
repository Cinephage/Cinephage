import { db } from '#lib/server/db/index.js';
import {
	series,
	seasons,
	episodes,
	rootFolders,
	libraries,
	scoringProfiles,
	episodeFiles,
	downloadQueue
} from '#lib/server/db/schema.js';
import { eq, and, inArray, ne, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import type { LibrarySeries, EpisodeFile, QualityProfileSummary } from '#lib/types/library.js';
import { todayDateString } from '#lib/utils/format.js';
import { matchesSeriesStatusFilter } from '#lib/utils/format-status.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getLanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'LibraryTvListPage', logDomain: 'scans' });

export const load: PageServerLoad = async ({ url }) => {
	// Parse URL params for sorting and filtering
	const sort = url.searchParams.get('sort') || 'title-asc';
	const monitored = url.searchParams.get('monitored') || 'all';
	const status = url.searchParams.get('status') || 'all';
	const progress = url.searchParams.get('progress') || 'all';
	const missing = url.searchParams.get('missing') || 'all';
	const qualityProfile = url.searchParams.get('qualityProfile') || 'all';
	const resolution = url.searchParams.get('resolution') || 'all';
	const videoCodec = url.searchParams.get('videoCodec') || 'all';
	const hdrFormat = url.searchParams.get('hdrFormat') || 'all';
	const requestedLibraryScope = url.searchParams.get('library')?.trim() || '';

	try {
		const availableLibraries = await getLibraryEntityService().listLibraries({ mediaType: 'tv' });
		const defaultLibrary =
			availableLibraries.find((library) => library.isDefault) ?? availableLibraries[0] ?? null;
		const selectedLibrary =
			availableLibraries.find(
				(library) => library.slug === requestedLibraryScope || library.id === requestedLibraryScope
			) ?? defaultLibrary;
		const hasSubLibraries = availableLibraries.some((library) => !library.isDefault);
		const isSubLibraryScope = Boolean(selectedLibrary && !selectedLibrary.isDefault);

		// Fetch all series with their root folder info
		const allSeries = await db
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
				libraryId: series.libraryId,
				rootFolderPath: rootFolders.path,
				rootFolderMediaType: rootFolders.mediaType,
				rootFolderMediaSubType: rootFolders.mediaSubType,
				librarySlug: libraries.slug,
				libraryName: libraries.name,
				libraryMediaSubType: libraries.mediaSubType,
				libraryIsDefault: libraries.isDefault,
				scoringProfileId: series.scoringProfileId,
				monitored: series.monitored,
				seasonFolder: series.seasonFolder,
				wantsSubtitles: series.wantsSubtitles,
				preferOriginalTitle: series.preferOriginalTitle,
				added: series.added,
				episodeCount: series.episodeCount,
				episodeFileCount: series.episodeFileCount
			})
			.from(series)
			.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
			.leftJoin(libraries, eq(series.libraryId, libraries.id));

		const seriesIds = allSeries.map((s) => s.id);

		// Fetch active queue series IDs (including paused/seeding states)
		const activeQueueSeries = await db
			.select({ seriesId: downloadQueue.seriesId })
			.from(downloadQueue)
			.where(
				and(
					isNotNull(downloadQueue.seriesId),
					inArray(downloadQueue.status, [...ACTIVE_DOWNLOAD_STATUSES])
				)
			);
		const downloadingSeriesIds = new Set(activeQueueSeries.map((q) => q.seriesId!));

		const allRegularEpisodes =
			seriesIds.length > 0
				? await db
						.select({
							id: episodes.id,
							seriesId: episodes.seriesId,
							airDate: episodes.airDate,
							monitored: episodes.monitored
						})
						.from(episodes)
						.where(and(inArray(episodes.seriesId, seriesIds), ne(episodes.seasonNumber, 0)))
				: [];
		const today = todayDateString();
		const isAired = (ep: { airDate: string | null }) =>
			Boolean(ep.airDate && ep.airDate !== '' && ep.airDate <= today);
		const regularEpisodeIdToSeries = new Map(
			allRegularEpisodes.filter(isAired).map((ep) => [ep.id, ep.seriesId])
		);
		const episodeTotalsBySeries = new Map<string, number>();
		const monitoredEpisodeBySeries = new Map<string, number>();
		for (const episode of allRegularEpisodes.filter(isAired)) {
			episodeTotalsBySeries.set(
				episode.seriesId,
				(episodeTotalsBySeries.get(episode.seriesId) ?? 0) + 1
			);
			if (episode.monitored !== false) {
				monitoredEpisodeBySeries.set(
					episode.seriesId,
					(monitoredEpisodeBySeries.get(episode.seriesId) ?? 0) + 1
				);
			}
		}

		// Fetch all episode files for file-type filtering and derived episode-file
		// counts (episodeIds is a JSON array cross-referenced against aired
		// episodes below.
		const resolutionExpr = sql`json_extract(${episodeFiles.quality}, '$.resolution')`;
		const codecExpr = sql`json_extract(${episodeFiles.mediaInfo}, '$.videoCodec')`;
		const hdrExpr = sql`json_extract(${episodeFiles.mediaInfo}, '$.hdrFormat')`;
		const [allEpisodeFiles, sizeBySeriesRows, resolutionRows, codecRows, hdrRows] =
			await Promise.all([
				db
					.select({
						seriesId: episodeFiles.seriesId,
						episodeIds: episodeFiles.episodeIds,
						size: episodeFiles.size,
						quality: episodeFiles.quality,
						mediaInfo: episodeFiles.mediaInfo
					})
					.from(episodeFiles),
				db
					.select({
						seriesId: episodeFiles.seriesId,
						total: sql<number>`coalesce(sum(${episodeFiles.size}), 0)`
					})
					.from(episodeFiles)
					.groupBy(episodeFiles.seriesId),
				db
					.select({ value: resolutionExpr.as('value') })
					.from(episodeFiles)
					.where(sql`${resolutionExpr} IS NOT NULL`)
					.groupBy(resolutionExpr),
				db
					.select({ value: codecExpr.as('value') })
					.from(episodeFiles)
					.where(sql`${codecExpr} IS NOT NULL`)
					.groupBy(codecExpr),
				db
					.select({ value: hdrExpr.as('value') })
					.from(episodeFiles)
					.where(sql`${hdrExpr} IS NOT NULL`)
					.groupBy(hdrExpr)
			]);

		const episodeFilesBySeries = new Map<string, Set<string>>();
		for (const file of allEpisodeFiles) {
			const linkedEpisodeIds = (file.episodeIds as string[] | null) ?? [];
			if (linkedEpisodeIds.length === 0) continue;
			const seriesId = file.seriesId;
			let tracked = episodeFilesBySeries.get(seriesId);
			if (!tracked) {
				tracked = new Set<string>();
				episodeFilesBySeries.set(seriesId, tracked);
			}
			for (const episodeId of linkedEpisodeIds) {
				if (regularEpisodeIdToSeries.get(episodeId) === seriesId) {
					tracked.add(episodeId);
				}
			}
		}

		// Calculate percentages and format data using derived episode/file linkage (source of truth).
		const seriesTotalSizeMap = new Map(sizeBySeriesRows.map((r) => [r.seriesId, r.total]));

		const seriesWithStats: (LibrarySeries & {
			libraryId?: string | null;
			rootFolderMediaSubType?: string | null;
			libraryMediaSubType?: string | null;
		})[] = allSeries.map((s) => {
			const derivedEpisodeCount = episodeTotalsBySeries.get(s.id) ?? 0;
			const derivedEpisodeFileCount = episodeFilesBySeries.get(s.id)?.size ?? 0;
			return {
				...s,
				episodeCount: derivedEpisodeCount,
				episodeFileCount: derivedEpisodeFileCount,
				missingCount: Math.max(0, derivedEpisodeCount - derivedEpisodeFileCount),
				missingRootFolder: !s.rootFolderId || !s.rootFolderPath || s.rootFolderMediaType !== 'tv',
				percentComplete:
					derivedEpisodeCount > 0
						? Math.round((derivedEpisodeFileCount / derivedEpisodeCount) * 100)
						: 0,
				totalSize: seriesTotalSizeMap.get(s.id) ?? 0,
				libraryId: s.libraryId ?? null,
				partiallyMonitored: (() => {
					if (s.monitored !== true) return false;
					const total = episodeTotalsBySeries.get(s.id) ?? 0;
					if (total === 0) return false;
					const monitored = monitoredEpisodeBySeries.get(s.id) ?? 0;
					return monitored > 0 && monitored < total;
				})()
			};
		}) as (LibrarySeries & {
			libraryId?: string | null;
			rootFolderMediaSubType?: string | null;
			libraryMediaSubType?: string | null;
		})[];

		const inferLegacySubtype = (show: {
			rootFolderMediaSubType?: string | null;
			libraryMediaSubType?: string | null;
		}): 'standard' | 'anime' => {
			const candidate = show.rootFolderMediaSubType ?? show.libraryMediaSubType;
			return candidate === 'anime' ? 'anime' : 'standard';
		};

		const belongsToScope = (
			show: {
				libraryId?: string | null;
				rootFolderMediaSubType?: string | null;
				libraryMediaSubType?: string | null;
			},
			scopeLibraryId: string,
			scopeMediaSubType: string
		): boolean => {
			if (show.libraryId) {
				return show.libraryId === scopeLibraryId;
			}
			const inferredSubtype = inferLegacySubtype(show);
			if (scopeMediaSubType === 'anime') return inferredSubtype === 'anime';
			if (scopeMediaSubType === 'standard') return inferredSubtype === 'standard';
			return false;
		};

		const seriesInSelectedLibrary = selectedLibrary
			? seriesWithStats.filter((show) =>
					belongsToScope(show, selectedLibrary.id, selectedLibrary.mediaSubType)
				)
			: seriesWithStats;

		const libraryScopeOptions = availableLibraries.map((library) => ({
			id: library.id,
			slug: library.slug,
			name: library.name,
			isDefault: library.isDefault,
			mediaSubType: library.mediaSubType,
			count: seriesWithStats.filter((show) =>
				belongsToScope(show, library.id, library.mediaSubType)
			).length
		}));

		// Unique file attribute values for filter dropdowns.
		const uniqueResolutions = new Set(resolutionRows.map((r) => r.value as string));
		const uniqueCodecs = new Set(codecRows.map((r) => r.value as string));
		const uniqueHdrFormats = new Set(hdrRows.map((r) => r.value as string));

		// Fetch quality profiles and resolve the effective default profile ID
		const dbProfiles = await db
			.select({
				id: scoringProfiles.id,
				name: scoringProfiles.name,
				description: scoringProfiles.description,
				isDefault: scoringProfiles.isDefault,
				isBuiltIn: scoringProfiles.isBuiltIn
			})
			.from(scoringProfiles);

		const resolvedDefaultId =
			dbProfiles.find((p) => !p.isBuiltIn && p.isDefault)?.id ??
			dbProfiles.find((p) => p.isBuiltIn && p.isDefault)?.id ??
			'balanced';
		const effectiveQualityProfileFilter =
			qualityProfile === 'default' ? resolvedDefaultId : qualityProfile;

		const qualityProfiles: QualityProfileSummary[] = dbProfiles.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description ?? '',
			isBuiltIn: !!p.isBuiltIn,
			isDefault: p.id === resolvedDefaultId
		}));

		// Build sets of series IDs that have matching files (for filtering).
		const seriesWithResolution = new Set<string>();
		const seriesWithCodec = new Set<string>();
		const seriesWithHdr = new Set<string>();
		const seriesWithSdr = new Set<string>();
		const needsResolutionMembership = resolution !== 'all';
		const needsCodecMembership = videoCodec !== 'all';
		const needsSdrMembership = hdrFormat === 'sdr';
		const needsHdrMembership = hdrFormat !== 'all' && hdrFormat !== 'sdr';

		if (
			needsResolutionMembership ||
			needsCodecMembership ||
			needsSdrMembership ||
			needsHdrMembership
		) {
			for (const file of allEpisodeFiles) {
				const quality = file.quality as EpisodeFile['quality'];
				const mediaInfo = file.mediaInfo as EpisodeFile['mediaInfo'];

				if (needsResolutionMembership && quality?.resolution === resolution) {
					seriesWithResolution.add(file.seriesId);
				}
				if (needsCodecMembership && mediaInfo?.videoCodec === videoCodec) {
					seriesWithCodec.add(file.seriesId);
				}
				if (needsSdrMembership && !mediaInfo?.hdrFormat) {
					seriesWithSdr.add(file.seriesId);
				}
				if (needsHdrMembership && mediaInfo?.hdrFormat === hdrFormat) {
					seriesWithHdr.add(file.seriesId);
				}
			}
		}

		// Apply filters (within selected library scope)
		let filteredSeries = seriesInSelectedLibrary;

		// Filter by monitored status
		if (monitored === 'monitored') {
			filteredSeries = filteredSeries.filter((s) => s.monitored && !s.partiallyMonitored);
		} else if (monitored === 'unmonitored') {
			filteredSeries = filteredSeries.filter((s) => !s.monitored);
		} else if (monitored === 'partial') {
			filteredSeries = filteredSeries.filter((s) => s.partiallyMonitored);
		}

		// Filter by series status
		if (status === 'continuing' || status === 'ended' || status === 'cancelled') {
			filteredSeries = filteredSeries.filter((s) => matchesSeriesStatusFilter(s.status, status));
		}

		// Filter by progress
		if (progress === 'complete') {
			filteredSeries = filteredSeries.filter((s) => s.percentComplete === 100);
		} else if (progress === 'inProgress') {
			filteredSeries = filteredSeries.filter(
				(s) => s.percentComplete > 0 && s.percentComplete < 100
			);
		} else if (progress === 'notStarted') {
			filteredSeries = filteredSeries.filter((s) => s.percentComplete === 0);
		}

		// Filter by missing episodes (aired episodes without a file)
		if (missing === 'missing') {
			filteredSeries = filteredSeries.filter((s) => (s.missingCount ?? 0) > 0);
		}

		// Filter by quality profile (treat null as "uses resolved default profile")
		if (effectiveQualityProfileFilter !== 'all') {
			filteredSeries = filteredSeries.filter(
				(s) => (s.scoringProfileId ?? resolvedDefaultId) === effectiveQualityProfileFilter
			);
		}

		// Filter by resolution
		if (resolution !== 'all') {
			filteredSeries = filteredSeries.filter((s) => seriesWithResolution.has(s.id));
		}

		// Filter by video codec
		if (videoCodec !== 'all') {
			filteredSeries = filteredSeries.filter((s) => seriesWithCodec.has(s.id));
		}

		// Filter by HDR format
		if (hdrFormat === 'sdr') {
			filteredSeries = filteredSeries.filter((s) => seriesWithSdr.has(s.id));
		} else if (hdrFormat !== 'all') {
			filteredSeries = filteredSeries.filter((s) => seriesWithHdr.has(s.id));
		}

		// Apply sorting
		const [sortField, sortDir] = sort.split('-') as [string, 'asc' | 'desc'];
		filteredSeries.sort((a, b) => {
			let comparison: number;

			switch (sortField) {
				case 'title':
					comparison = (a.title || '').localeCompare(b.title || '');
					break;
				case 'added':
					comparison = new Date(a.added).getTime() - new Date(b.added).getTime();
					break;
				case 'year':
					comparison = (a.year || 0) - (b.year || 0);
					break;
				case 'progress':
					comparison = a.percentComplete - b.percentComplete;
					break;
				case 'missing':
					comparison = (a.missingCount ?? 0) - (b.missingCount ?? 0);
					break;
				case 'missingPercent':
					comparison = 100 - a.percentComplete - (100 - b.percentComplete);
					break;
				case 'size':
					comparison = (seriesTotalSizeMap.get(a.id) ?? 0) - (seriesTotalSizeMap.get(b.id) ?? 0);
					break;
				default:
					comparison = (a.title || '').localeCompare(b.title || '');
			}

			return sortDir === 'desc' ? -comparison : comparison;
		});

		// Sort unique values for consistent dropdown ordering
		const resolutionOrder = ['2160p', '1080p', '720p', '576p', '480p'];
		const sortedResolutions = [...uniqueResolutions].sort(
			(a, b) =>
				(resolutionOrder.indexOf(a) === -1 ? 999 : resolutionOrder.indexOf(a)) -
				(resolutionOrder.indexOf(b) === -1 ? 999 : resolutionOrder.indexOf(b))
		);

		// Instance display default for items with no explicit per-item flag.
		const preferOriginalTitleDefault = (await getLanguageSettingsService().get())
			.preferOriginalTitle;

		return {
			series: filteredSeries,
			total: filteredSeries.length,
			totalUnfiltered: seriesInSelectedLibrary.length,
			downloadingSeriesIds: [...downloadingSeriesIds],
			preferOriginalTitleDefault,
			filters: {
				sort,
				library: selectedLibrary?.slug ?? '',
				monitored,
				status,
				progress,
				missing,
				qualityProfile: effectiveQualityProfileFilter,
				resolution,
				videoCodec,
				hdrFormat
			},
			libraryScope: {
				selected: selectedLibrary
					? {
							id: selectedLibrary.id,
							slug: selectedLibrary.slug,
							name: selectedLibrary.name,
							isDefault: selectedLibrary.isDefault,
							mediaSubType: selectedLibrary.mediaSubType
						}
					: null,
				options: libraryScopeOptions,
				hasSubLibraries,
				isSubLibraryScope
			},
			qualityProfiles,
			uniqueResolutions: sortedResolutions,
			uniqueCodecs: [...uniqueCodecs].sort(),
			uniqueHdrFormats: [...uniqueHdrFormats].sort()
		};
	} catch (error) {
		logger.error({ err: error }, '[TV Page] Error loading series');
		const emptySeries: LibrarySeries[] = [];
		const emptyProfiles: QualityProfileSummary[] = [];
		const emptyStrings: string[] = [];
		return {
			series: emptySeries,
			total: 0,
			totalUnfiltered: 0,
			downloadingSeriesIds: [] as string[],
			preferOriginalTitleDefault: false,
			filters: {
				sort,
				library: '',
				monitored,
				status,
				progress,
				missing,
				qualityProfile,
				resolution,
				videoCodec,
				hdrFormat
			},
			libraryScope: {
				selected: null,
				options: [],
				hasSubLibraries: false,
				isSubLibraryScope: false
			},
			qualityProfiles: emptyProfiles,
			uniqueResolutions: emptyStrings,
			uniqueCodecs: emptyStrings,
			uniqueHdrFormats: emptyStrings,
			error: 'Failed to load TV shows'
		};
	}
};

export const actions: Actions = {
	toggleAllMonitored: async ({ locals, request }) => {
		// Bulk monitoring is an admin operation; viewer sessions can browse
		// the list page but never submit its form actions.
		requireAdminPage(locals);
		const formData = await request.formData();
		const monitored = formData.get('monitored') === 'true';

		try {
			const requestedLibraryScope = (formData.get('library') as string | null)?.trim() || '';

			const availableLibraries = await getLibraryEntityService().listLibraries({ mediaType: 'tv' });
			const defaultLibrary =
				availableLibraries.find((library) => library.isDefault) ?? availableLibraries[0] ?? null;
			const selectedLibrary =
				availableLibraries.find(
					(library) =>
						library.slug === requestedLibraryScope || library.id === requestedLibraryScope
				) ?? defaultLibrary;

			if (!selectedLibrary) {
				// Global toggle across every series - no scoping needed for the cascade.
				await db.update(series).set({ monitored });
				await db.update(seasons).set({ monitored });
				await db.update(episodes).set({ monitored });
				libraryMediaEvents.emitLibraryDataChanged({
					source: 'series',
					reason: 'toggle-all-monitored'
				});
				return { success: true };
			}

			// Series with a real libraryId (the modern, common case) can be updated
			// and cascaded directly via a correlated subquery - no row fetch needed.
			// Only legacy series with libraryId NULL need the join-based subtype
			// inference below, scoped to just that (shrinking) subset.
			const modernSeriesIds = db
				.select({ id: series.id })
				.from(series)
				.where(eq(series.libraryId, selectedLibrary.id));
			await db.update(series).set({ monitored }).where(eq(series.libraryId, selectedLibrary.id));
			await db.update(seasons).set({ monitored }).where(inArray(seasons.seriesId, modernSeriesIds));
			await db
				.update(episodes)
				.set({ monitored })
				.where(inArray(episodes.seriesId, modernSeriesIds));

			const legacySeries = await db
				.select({
					id: series.id,
					rootFolderMediaSubType: rootFolders.mediaSubType,
					libraryMediaSubType: libraries.mediaSubType
				})
				.from(series)
				.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
				.leftJoin(libraries, eq(series.libraryId, libraries.id))
				.where(isNull(series.libraryId));

			const inferLegacySubtype = (show: {
				rootFolderMediaSubType?: string | null;
				libraryMediaSubType?: string | null;
			}): 'standard' | 'anime' => {
				const candidate = show.rootFolderMediaSubType ?? show.libraryMediaSubType;
				return candidate === 'anime' ? 'anime' : 'standard';
			};

			const scopedIds = legacySeries
				.filter((show) => {
					const inferredSubtype = inferLegacySubtype(show);
					if (selectedLibrary.mediaSubType === 'anime') return inferredSubtype === 'anime';
					if (selectedLibrary.mediaSubType === 'standard') return inferredSubtype === 'standard';
					return false;
				})
				.map((s) => s.id);

			if (scopedIds.length > 0) {
				await db.update(series).set({ monitored }).where(inArray(series.id, scopedIds));
				await db.update(seasons).set({ monitored }).where(inArray(seasons.seriesId, scopedIds));
				await db.update(episodes).set({ monitored }).where(inArray(episodes.seriesId, scopedIds));
			}

			libraryMediaEvents.emitLibraryDataChanged({
				source: 'series',
				reason: 'toggle-all-monitored'
			});

			return { success: true };
		} catch (error) {
			logger.error({ err: error }, '[TV] Failed to toggle all monitored');
			return { success: false, error: 'Failed to update series' };
		}
	}
};

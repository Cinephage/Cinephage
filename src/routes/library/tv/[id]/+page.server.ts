import { db } from '#lib/server/db/index.js';
import { delayProfileService } from '#lib/server/monitoring/specifications/DelaySpecification.js';
import {
	series,
	seasons,
	episodes,
	episodeFiles,
	rootFolders,
	scoringProfiles,
	downloadQueue,
	subtitles,
	libraries
} from '#lib/server/db/schema.js';
import { eq, asc, inArray, and } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { isSeriesSearching } from '#lib/server/library/ActiveSearchTracker.js';
import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';
import type { QualityProfileSummary } from '#lib/types/library.js';
import type { TVShowDetails } from '#lib/types/tmdb.js';
import { tmdb } from '#lib/server/tmdb.js';
import { getMetadataProviderConfig } from '#lib/server/metadata/provider-settings.js';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { getLanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import type {
	EffectiveSubtitleRequirements,
	EffectiveLanguageProfile,
	EpisodeSubtitleCounts
} from '#lib/shared/language-profile.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryTvPage', logDomain: 'scans' });

export interface SeasonWithEpisodes {
	id: string;
	seasonNumber: number;
	name: string | null;
	overview: string | null;
	posterPath: string | null;
	airDate: string | null;
	monitored: boolean | null;
	episodeCount: number | null;
	episodeFileCount: number | null;
	episodes: EpisodeWithFile[];
}

export interface SubtitleInfo {
	id: string;
	language: string;
	isForced?: boolean;
	isHearingImpaired?: boolean;
	format?: string;
	matchScore?: number | null;
	providerId?: string | null;
	dateAdded?: string | null;
	wasSynced?: boolean;
	syncOffset?: number | null;
	isEmbedded?: boolean;
}

export interface EpisodeWithFile {
	id: string;
	tmdbId: number | null;
	tvdbId: number | null;
	seasonNumber: number;
	episodeNumber: number;
	absoluteEpisodeNumber: number | null;
	title: string | null;
	overview: string | null;
	airDate: string | null;
	runtime: number | null;
	monitored: boolean | null;
	hasFile: boolean | null;
	/** Tri-state subtitle gate (null = inherit from series). */
	wantsSubtitlesOverride: boolean | null;
	file: EpisodeFileInfo | null;
	subtitles?: SubtitleInfo[];
	/** Cutoff-aware requirement progress; null when the series has no effective profile. */
	subtitleCounts?: EpisodeSubtitleCounts | null;
}

export interface EpisodeFileInfo {
	id: string;
	relativePath: string;
	size: number | null;
	dateAdded: string | null;
	sceneName: string | null;
	releaseGroup: string | null;
	releaseType: string | null;
	quality: {
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	} | null;
	mediaInfo: {
		containerFormat?: string;
		videoCodec?: string;
		videoProfile?: string;
		videoBitrate?: number;
		videoBitDepth?: number;
		videoHdrFormat?: string;
		width?: number;
		height?: number;
		audioCodec?: string;
		audioChannels?: number;
		audioLanguages?: string[];
		subtitleLanguages?: string[];
	} | null;
	languages: string[] | null;
}

export interface QueueItemInfo {
	id: string;
	title: string;
	status: string;
	progress: number | null;
	episodeIds: string[] | null;
	seasonNumber: number | null;
}

export interface LibrarySeriesPageData {
	series: {
		id: string;
		tmdbId: number;
		tvdbId: number | null;
		imdbId: string | null;
		/** Probed audio contradicts the effective audio preference (phase D) */
		languageShortfall?: boolean | null;
		providerRefs: Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null;
		title: string;
		originalTitle: string | null;
		year: number | null;
		overview: string | null;
		posterPath: string | null;
		backdropPath: string | null;
		status: string | null;
		network: string | null;
		genres: string[] | null;
		path: string;
		rootFolderId: string | null;
		rootFolderPath: string | null;
		scoringProfileId: string | null;
		monitored: boolean | null;
		seasonFolder: boolean | null;
		seriesType: string | null;
		wantsSubtitles: boolean | null;
		languageProfileId: string | null;
		added: string;
		episodeCount: number | null;
		episodeFileCount: number | null;
		episodeGroupId: string | null;
		percentComplete: number;
		metadataLanguage?: string | null;
		preferOriginalTitle?: boolean | null;
	};
	tmdbDetails: TVShowDetails | null;
	seasons: SeasonWithEpisodes[];
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
	queueItems: QueueItemInfo[];
	isSearching: boolean;
	configuredMetadataProviders: {
		anilist: boolean;
		mal: boolean;
	};
	librarySlug: string | null;
	libraryName: string | null;
	/** The profile governing the series plus the level it was resolved from. */
	effectiveLanguageProfile: EffectiveLanguageProfile | null;
	effectiveSubtitleRequirements: EffectiveSubtitleRequirements | null;
	/** Language profiles available for the per-item subtitle profile override. */
	languageProfiles: Array<{ id: string; name: string }>;
	/** Instance default for original-title display (language_settings.prefer_original_title). */
	preferOriginalTitleDefault: boolean;
}

export const load: PageServerLoad = async ({ params }): Promise<LibrarySeriesPageData> => {
	const { id } = params;

	// Fetch the series with root folder info
	const seriesResult = await db
		.select({
			id: series.id,
			tmdbId: series.tmdbId,
			tvdbId: series.tvdbId,
			imdbId: series.imdbId,
			providerRefs: series.providerRefs,
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
			monitored: series.monitored,
			languageShortfall: series.languageShortfall,
			seasonFolder: series.seasonFolder,
			seriesType: series.seriesType,
			wantsSubtitles: series.wantsSubtitles,
			added: series.added,
			episodeCount: series.episodeCount,
			episodeFileCount: series.episodeFileCount,
			episodeGroupId: series.episodeGroupId,
			libraryId: series.libraryId,
			librarySlug: libraries.slug,
			libraryName: libraries.name,
			libraryIsDefault: libraries.isDefault,
			languageProfileId: series.languageProfileId,
			metadataLanguageMode: series.metadataLanguageMode,
			metadataLanguageValue: series.metadataLanguageValue,
			metadataLanguage: series.metadataLanguage,
			preferOriginalTitle: series.preferOriginalTitle
		})
		.from(series)
		.leftJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
		.leftJoin(libraries, eq(series.libraryId, libraries.id))
		.where(eq(series.id, id));

	if (seriesResult.length === 0) {
		error(404, 'Series not found in library');
	}

	const seriesData = seriesResult[0];

	// Calculate percent complete
	const percentComplete =
		seriesData.episodeCount && seriesData.episodeCount > 0
			? Math.round(((seriesData.episodeFileCount || 0) / seriesData.episodeCount) * 100)
			: 0;

	// Fetch all seasons
	const allSeasons = await db
		.select()
		.from(seasons)
		.where(eq(seasons.seriesId, id))
		.orderBy(asc(seasons.seasonNumber));

	// Fetch all episodes
	const allEpisodes = await db
		.select()
		.from(episodes)
		.where(eq(episodes.seriesId, id))
		.orderBy(asc(episodes.seasonNumber), asc(episodes.episodeNumber));

	// Fetch all episode files
	const allFiles = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, id));

	// Create a map of episode ID to file
	const episodeIdToFile = new Map<string, EpisodeFileInfo>();
	for (const file of allFiles) {
		const episodeIds = file.episodeIds as string[] | null;
		if (episodeIds) {
			for (const epId of episodeIds) {
				episodeIdToFile.set(epId, {
					id: file.id,
					relativePath: file.relativePath,
					size: file.size,
					dateAdded: file.dateAdded,
					sceneName: file.sceneName,
					releaseGroup: file.releaseGroup,
					releaseType: file.releaseType,
					quality: file.quality as EpisodeFileInfo['quality'],
					mediaInfo: file.mediaInfo as EpisodeFileInfo['mediaInfo'],
					languages: file.languages as string[] | null
				});
			}
		}
	}

	// Fetch subtitles for all episodes in this series. Full rows are loaded so
	// the batch requirement-count pass can resolve on-disk paths for each row.
	const episodeIds = allEpisodes.map((ep) => ep.id);
	const allSubtitles =
		episodeIds.length > 0
			? await db.select().from(subtitles).where(inArray(subtitles.episodeId, episodeIds))
			: [];

	// Group subtitles by episode id, seeding every episode (even without rows)
	// so each one gets a requirement-count entry.
	const subtitlesByEpisode = new Map<string, Array<typeof subtitles.$inferSelect>>();
	for (const ep of allEpisodes) {
		subtitlesByEpisode.set(ep.id, []);
	}
	for (const sub of allSubtitles) {
		if (sub.episodeId) {
			subtitlesByEpisode.get(sub.episodeId)?.push(sub);
		}
	}

	// Cutoff-aware per-episode requirement progress, computed server-side in
	// ONE batched pass over the already-fetched rows + the series' effective
	// profile (constant query count — safe for very large libraries).
	const profileService = getLanguageProfileService();
	const [effectiveLanguageProfile, effectiveSubtitleRequirements, episodeSubtitleCounts] =
		await Promise.all([
			profileService.getEffectiveProfileForSeries(id),
			profileService.getEffectiveSubtitleRequirements({ seriesId: id }),
			profileService.getSeriesEpisodeSubtitleCounts(id, subtitlesByEpisode)
		]);
	const languageSettings = await getLanguageSettingsService().get();
	const preferOriginalTitleDefault = languageSettings.preferOriginalTitle;

	// Build seasons with episodes
	const seasonsWithEpisodes: SeasonWithEpisodes[] = allSeasons.map((season) => {
		const seasonEpisodes = allEpisodes
			.filter((ep) => ep.seasonNumber === season.seasonNumber)
			.map((ep) => ({
				id: ep.id,
				tmdbId: ep.tmdbId,
				tvdbId: ep.tvdbId,
				seasonNumber: ep.seasonNumber,
				episodeNumber: ep.episodeNumber,
				absoluteEpisodeNumber: ep.absoluteEpisodeNumber,
				title: ep.title,
				overview: ep.overview,
				airDate: ep.airDate,
				runtime: ep.runtime,
				monitored: ep.monitored,
				hasFile: ep.hasFile,
				wantsSubtitlesOverride: ep.wantsSubtitlesOverride ?? null,
				file: episodeIdToFile.get(ep.id) || null,
				subtitles: (subtitlesByEpisode.get(ep.id) || []).map((sub): SubtitleInfo => ({
					id: sub.id,
					language: sub.language,
					isForced: sub.isForced ?? undefined,
					isHearingImpaired: sub.isHearingImpaired ?? undefined,
					format: sub.format ?? undefined,
					matchScore: sub.matchScore,
					providerId: sub.providerId,
					dateAdded: sub.dateAdded,
					wasSynced: sub.wasSynced ?? undefined,
					syncOffset: sub.syncOffset
				})),
				subtitleCounts: episodeSubtitleCounts.get(ep.id) ?? null
			}));

		return {
			id: season.id,
			seasonNumber: season.seasonNumber,
			name: season.name,
			overview: season.overview,
			posterPath: season.posterPath,
			airDate: season.airDate,
			monitored: season.monitored,
			episodeCount: season.episodeCount,
			episodeFileCount: season.episodeFileCount,
			episodes: seasonEpisodes
		};
	});

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

	const allQualityProfiles: QualityProfileSummary[] = dbProfiles.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description ?? '',
		isBuiltIn: !!p.isBuiltIn,
		isDefault: p.id === resolvedDefaultId
	}));

	// Language profiles for the edit modal's subtitle-profile override select.
	const languageProfiles = (await profileService.getProfiles()).map((p) => ({
		id: p.id,
		name: p.name
	}));

	// Fetch TV root folders
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
		.where(eq(rootFolders.mediaType, 'tv'));

	// Fetch active queue items for this series
	const queueResults = await db
		.select({
			id: downloadQueue.id,
			title: downloadQueue.title,
			status: downloadQueue.status,
			progress: downloadQueue.progress,
			episodeIds: downloadQueue.episodeIds,
			seasonNumber: downloadQueue.seasonNumber
		})
		.from(downloadQueue)
		.where(
			and(
				eq(downloadQueue.seriesId, id),
				inArray(downloadQueue.status, [...ACTIVE_DOWNLOAD_STATUSES])
			)
		);

	const queueItems: QueueItemInfo[] = queueResults.map((q) => ({
		id: q.id,
		title: q.title,
		status: q.status ?? 'queued',
		progress: q.progress ? parseFloat(q.progress) : null,
		episodeIds: q.episodeIds as string[] | null,
		seasonNumber: q.seasonNumber
	}));

	// Check if a search is currently running for this series
	const isSearching = isSeriesSearching(id);
	const providerConfig = await getMetadataProviderConfig();
	const configuredMetadataProviders = {
		anilist: providerConfig.animeEnrichmentEnabled,
		mal: providerConfig.animeEnrichmentEnabled
	};

	// AniList/Jikan(MAL) enrichment is NOT looked up here. It used to be
	// (first awaited directly, then streamed as an unawaited promise), but
	// even streamed it still visibly delayed first paint in practice -
	// something between this app and the browser (proxy, adapter, or
	// SvelteKit's own streaming semantics) wasn't actually deferring it the
	// way the "don't await" pattern assumes. Moved to a dedicated endpoint
	// (/api/library/series/[id]/anime-refs) that the client calls after the
	// page has already rendered - see +page.svelte. This page only ever
	// shows whatever provider refs are already stored.
	const existingProviderRefs =
		(seriesData.providerRefs as Partial<Record<'tmdb' | 'anilist' | 'mal', string>> | null) ??
		undefined;

	const tmdbDetails = await tmdb.getTVShow(seriesData.tmdbId).catch((err) => {
		logger.warn(
			{
				seriesId: id,
				tmdbId: seriesData.tmdbId,
				error: err instanceof Error ? err.message : String(err)
			},
			'[LibrarySeries] Failed to fetch TMDB TV show details'
		);
		return null;
	});

	const librarySlug = seriesData.libraryIsDefault ? null : (seriesData.librarySlug ?? null);
	const libraryName = seriesData.libraryName ?? null;

	const delayProfiles = await delayProfileService.getProfiles();

	return {
		series: {
			...seriesData,
			providerRefs: existingProviderRefs ?? {},
			added: seriesData.added ?? new Date().toISOString(),
			percentComplete
		},
		tmdbDetails,
		seasons: seasonsWithEpisodes,
		qualityProfiles: allQualityProfiles,
		delayProfiles,
		rootFolders: folders,
		queueItems,
		isSearching,
		configuredMetadataProviders,
		librarySlug,
		libraryName,
		effectiveLanguageProfile,
		effectiveSubtitleRequirements,
		languageProfiles,
		preferOriginalTitleDefault
	};
};

import { randomUUID } from 'node:crypto';

import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import {
	fetchSeriesDetails,
	fetchSeriesExternalIds,
	validateRootFolder,
	getAnimeSubtypeEnforcement,
	getEffectiveScoringProfileId,
	triggerSeriesSearch
} from '#lib/server/library/LibraryAddService.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { fetchAndStoreSeriesAlternateTitles } from '#lib/server/services/AlternateTitleService.js';
import {
	buildDefaultOrderingPlan,
	persistEpisodePlanIn,
	resolveEpisodeGroupPlan,
	type SeriesEpisodePlan
} from '#lib/server/metadata/series-episode-plan.js';
import { ValidationError } from '#lib/errors/index.js';
import { NamingService, type MediaNamingInfo } from '#lib/server/library/naming/NamingService.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { resolveLocalizedTitlesForFormats } from '#lib/server/library/naming/localization.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import type { AddSeriesRequest } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SeriesAdd', logDomain: 'scans' });

export type AddSeriesInput = AddSeriesRequest;

export type AddSeriesResult =
	| {
			outcome: 'added';
			seriesId: string;
			tmdbId: number;
			title: string;
			year: number | null;
			path: string;
			monitored: boolean;
			episodeCount: number;
			searchTriggered: boolean;
			searchWarning?: string;
	  }
	| { outcome: 'exists'; seriesId: string };

/** Episode-scope key for membership checks against stored episode numbering. */
function episodeKey(seasonNumber: number, episodeNumber: number): string {
	return `${seasonNumber}x${episodeNumber}`;
}

async function generateSeriesFolderName(
	title: string,
	year?: number,
	tvdbId?: number,
	tmdbId?: number,
	imdbId?: string,
	originalTitle?: string
): Promise<string> {
	const config = namingSettingsService.getConfigSync();
	const namingService = new NamingService(config);
	// Parity with rename preview: localized-title tokens resolve at add time.
	const localizedTitles = tmdbId ? await resolveLocalizedTitlesForFormats('series', tmdbId) : {};
	const info: MediaNamingInfo = {
		title,
		originalTitle,
		year,
		tvdbId,
		tmdbId,
		imdbId,
		localizedTitles
	};
	return namingService.generateSeriesFolderName(info);
}

/**
 * Shared series-add orchestration behind both POST /api/library/series and
 * request approval — the single implementation, not duplicated anywhere.
 *
 * Episode-selection semantics: when `monitoredEpisodes` is provided it wins —
 * exactly the listed episodes are monitored, and a season is monitored iff
 * it contains at least one listed episode. Otherwise the historical
 * monitorType / monitoredSeasons / monitorSpecials logic applies unchanged.
 */
export async function addSeriesToLibrary(input: AddSeriesInput): Promise<AddSeriesResult> {
	const {
		tmdbId,
		rootFolderId,
		scoringProfileId,
		monitored,
		seasonFolder,
		seriesType,
		monitorType,
		monitorNewItems,
		monitorSpecials,
		monitoredSeasons: providedSelectedSeasons,
		monitoredEpisodes,
		searchOnAdd: shouldSearch,
		wantsSubtitles,
		languageProfileId,
		subtitleRequirementsOverride
	} = input;

	if (languageProfileId) {
		const languageProfile = await getLanguageProfileService().getProfile(languageProfileId);
		if (!languageProfile) {
			throw new ValidationError(`Language profile not found: ${languageProfileId}`);
		}
	}

	const existingSeries = await db
		.select({ id: series.id })
		.from(series)
		.where(eq(series.tmdbId, tmdbId))
		.limit(1);

	if (existingSeries.length > 0) {
		return { outcome: 'exists', seriesId: existingSeries[0].id };
	}

	const tvDetails = await fetchSeriesDetails(tmdbId);
	const enforceAnimeSubtype = await getAnimeSubtypeEnforcement();
	const isAnimeMedia = isLikelyAnimeMedia({
		genres: tvDetails.genres,
		originalLanguage: tvDetails.original_language,
		originCountries: tvDetails.origin_country,
		productionCountries: tvDetails.production_countries,
		title: tvDetails.name,
		originalTitle: tvDetails.original_name
	});

	await validateRootFolder(rootFolderId, 'tv', {
		requireWritable: true,
		enforceAnimeSubtype,
		isAnimeMedia,
		mediaTitle: tvDetails.name
	});
	const owningLibrary = await getLibraryEntityService().resolveOwningLibraryForRootFolder(
		rootFolderId,
		'tv'
	);

	const { imdbId, tvdbId } = await fetchSeriesExternalIds(tmdbId);

	const year = tvDetails.first_air_date
		? new Date(tvDetails.first_air_date).getFullYear()
		: undefined;
	const folderName = await generateSeriesFolderName(
		tvDetails.name,
		year,
		tvdbId ?? undefined,
		tmdbId,
		imdbId ?? undefined,
		tvDetails.original_name ?? undefined
	);

	const totalEpisodes =
		tvDetails.seasons
			?.filter((s) => s.season_number !== 0 || monitorSpecials)
			.reduce((sum, s) => sum + (s.episode_count ?? 0), 0) ?? 0;

	const effectiveProfileId = await getEffectiveScoringProfileId(scoringProfileId, owningLibrary);

	// Pre-generate the series ID so the plan and the series row can commit
	// atomically below; the chosen ordering scheme is resolved up front.
	const seriesId = randomUUID();
	const resolution = await resolveEpisodeGroupPlan({
		seriesId,
		tmdbId,
		storedEpisodeGroupId: null,
		selection: 'auto'
	});
	const episodeGroupId = resolution.kind === 'episode-group' ? resolution.groupId : null;

	// Explicit episode selection narrows monitored seasons to the seasons
	// containing listed episodes (plus any explicitly provided seasons).
	const selectedEpisodes = monitoredEpisodes?.length
		? new Set(monitoredEpisodes.map((e) => episodeKey(e.seasonNumber, e.episodeNumber)))
		: null;
	const selectedSeasons = selectedEpisodes
		? [
				...new Set([
					...(providedSelectedSeasons ?? []),
					...(monitoredEpisodes?.map((e) => e.seasonNumber) ?? [])
				])
			]
		: providedSelectedSeasons;

	let defaultPlan: SeriesEpisodePlan | null = null;
	let failedSeasonNumbers: number[] = [];
	if (resolution.kind === 'default-ordering') {
		// Default TMDB ordering (or a rejected group fell back to it).
		const recentCutoffDate = new Date();
		recentCutoffDate.setDate(recentCutoffDate.getDate() - 90);
		const today = new Date();
		const positiveSeasons = (tvDetails.seasons ?? []).filter((s) => s.season_number > 0);
		const maxSeasonNumber =
			positiveSeasons.length > 0 ? Math.max(...positiveSeasons.map((s) => s.season_number)) : null;

		const built = await buildDefaultOrderingPlan({
			seriesId,
			seasonsSummary: tvDetails.seasons ?? [],
			fetchSeason: (seasonNumber) => tmdb.getSeason(tmdbId, seasonNumber),
			assignSeasonMonitored: (seasonNumber, isSpecials) => {
				if (selectedSeasons && selectedSeasons.length > 0) {
					return selectedSeasons.includes(seasonNumber);
				}
				if (isSpecials && !monitorSpecials) return false;
				switch (monitorType) {
					case 'all':
					case 'recent':
						return seasonNumber > 0 || monitorSpecials;
					case 'firstSeason':
						return seasonNumber === 1;
					case 'lastSeason':
						return maxSeasonNumber !== null && seasonNumber === maxSeasonNumber;
					case 'none':
						return false;
					default:
						return seasonNumber > 0 || monitorSpecials;
				}
			},
			assignEpisodeMonitored: ({ seasonNumber, episodeNumber, airDate, seasonMonitored }) => {
				if (selectedEpisodes) {
					return selectedEpisodes.has(episodeKey(seasonNumber, episodeNumber));
				}
				if (seasonMonitored && !selectedSeasons?.length) {
					const airDateValue = airDate ? new Date(airDate) : null;
					const hasAired = airDateValue ? airDateValue <= today : false;
					const isRecent = airDateValue ? airDateValue >= recentCutoffDate : false;
					switch (monitorType) {
						case 'pilot':
							return seasonNumber === 1 && episodeNumber === 1;
						case 'future':
							return !hasAired;
						case 'recent':
							return !hasAired || isRecent;
						default:
							return seasonMonitored;
					}
				}
				return seasonMonitored;
			},
			paceMs: 50
		});
		defaultPlan = built.plan;
		failedSeasonNumbers = built.failedSeasonNumbers;
	}

	// The series row and its seasons/episodes commit atomically: a failed
	// plan insert can no longer strand a series with no episodes.
	const [newSeries] = db.transaction((tx) => {
		const inserted = tx
			.insert(series)
			.values({
				id: seriesId,
				tmdbId,
				tvdbId,
				imdbId,
				title: tvDetails.name,
				originalLanguage: tvDetails.original_language,
				originalTitle: tvDetails.original_name,
				year,
				overview: tvDetails.overview,
				posterPath: tvDetails.poster_path,
				backdropPath: tvDetails.backdrop_path,
				status: tvDetails.status,
				network: tvDetails.networks?.[0]?.name ?? null,
				genres: tvDetails.genres?.map((g) => g.name) ?? [],
				path: folderName,
				libraryId: owningLibrary.id,
				rootFolderId,
				scoringProfileId: effectiveProfileId,
				monitored,
				monitorNewItems,
				monitorSpecials,
				seasonFolder,
				seriesType,
				episodeCount: totalEpisodes,
				episodeFileCount: 0,
				wantsSubtitles,
				languageProfileId: languageProfileId ?? null,
				subtitleRequirementsOverride: subtitleRequirementsOverride ?? null,
				episodeGroupId
			})
			.returning()
			.all();
		if (resolution.kind === 'episode-group') {
			persistEpisodePlanIn(tx, seriesId, resolution.plan, { wipe: false });
		} else if (defaultPlan) {
			persistEpisodePlanIn(tx, seriesId, defaultPlan, { wipe: false });
		}
		return inserted;
	});

	if (failedSeasonNumbers.length > 0) {
		logger.warn(
			{ seriesId, tmdbId, failedSeasonNumbers },
			'[SeriesAdd] Some seasons had no fetchable episode list; a series refresh can fill them'
		);
	}

	fetchAndStoreSeriesAlternateTitles(newSeries.id, tmdbId).catch((err) => {
		logger.warn(
			{
				seriesId: newSeries.id,
				tmdbId,
				error: err instanceof Error ? err.message : String(err)
			},
			'Failed to fetch alternate titles for series'
		);
	});

	let searchTriggered = false;
	let searchWarning: string | undefined;
	if (shouldSearch) {
		const searchResult = await triggerSeriesSearch({
			seriesId: newSeries.id,
			tmdbId,
			title: tvDetails.name
		});
		searchTriggered = searchResult.triggered;
		searchWarning = searchResult.searchWarning;
	}

	libraryMediaEvents.emitLibraryDataChanged({
		source: 'series',
		reason: 'series-added',
		entityId: newSeries.id,
		tmdbId
	});

	return {
		outcome: 'added',
		seriesId: newSeries.id,
		tmdbId,
		title: newSeries.title,
		year: newSeries.year ?? null,
		path: newSeries.path,
		monitored: newSeries.monitored ?? true,
		episodeCount: newSeries.episodeCount ?? 0,
		searchTriggered,
		searchWarning
	};
}

import { db } from '#lib/server/db/index.js';
import { series, seasons, episodes } from '#lib/server/db/schema.js';
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
	getEffectiveEpisodeGroup,
	buildSeasonsAndEpisodesFromGroup
} from '#lib/server/metadata/EpisodeGroupService.js';
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

	const { group: episodeGroup, selectedGroupId: episodeGroupId } = await getEffectiveEpisodeGroup(
		tmdbId,
		null
	);

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

	const [newSeries] = await db
		.insert(series)
		.values({
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
		.returning();

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

	if (episodeGroup) {
		// Use episode group mapping (e.g. TVDB Order, Crunchyroll split)
		const { seasonValues, episodeValues: groupEpisodeValues } = buildSeasonsAndEpisodesFromGroup(
			newSeries.id,
			episodeGroup
		);

		if (seasonValues.length > 0) {
			// Episode-group numbering is generated (1..N per split), so the
			// requested scope applies the same way as the default ordering:
			// explicit episode selection wins; otherwise selectedSeasons
			// gates season (and thus episode) monitoring; otherwise the
			// builder's defaults stand.
			const preparedSeasons =
				selectedEpisodes || selectedSeasons?.length
					? seasonValues.map((s) => ({
							...s,
							monitored: selectedEpisodes
								? monitoredEpisodes!.some((e) => e.seasonNumber === s.seasonNumber)
								: selectedSeasons!.includes(s.seasonNumber)
						}))
					: seasonValues;
			const insertedSeasons = await db.insert(seasons).values(preparedSeasons).returning();
			const seasonIdByNumber = new Map(insertedSeasons.map((s) => [s.seasonNumber, s.id]));

			const enrichedEpisodes = groupEpisodeValues.map((ep) => ({
				...ep,
				seasonId: seasonIdByNumber.get(ep.seasonNumber!) ?? null,
				monitored: selectedEpisodes
					? selectedEpisodes.has(episodeKey(ep.seasonNumber!, ep.episodeNumber!))
					: selectedSeasons?.length
						? selectedSeasons.includes(ep.seasonNumber!)
						: ep.seasonNumber === 0
							? monitorSpecials
							: ep.monitored
			}));

			if (enrichedEpisodes.length > 0) {
				await db.insert(episodes).values(enrichedEpisodes);
			}
		}
	} else if (tvDetails.seasons && tvDetails.seasons.length > 0) {
		// Default TMDB ordering
		for (const s of tvDetails.seasons) {
			let shouldMonitorSeason = false;

			if (selectedSeasons && selectedSeasons.length > 0) {
				shouldMonitorSeason = selectedSeasons.includes(s.season_number);
			} else {
				const isSpecials = s.season_number === 0;
				if (isSpecials && !monitorSpecials) {
					shouldMonitorSeason = false;
				} else {
					switch (monitorType) {
						case 'all':
							shouldMonitorSeason = s.season_number > 0 || monitorSpecials;
							break;
						case 'firstSeason':
							shouldMonitorSeason = s.season_number === 1;
							break;
						case 'lastSeason': {
							const maxSeasonNumber = Math.max(
								...tvDetails
									.seasons!.filter((ss) => ss.season_number > 0)
									.map((ss) => ss.season_number)
							);
							shouldMonitorSeason = s.season_number === maxSeasonNumber;
							break;
						}
						case 'recent':
							shouldMonitorSeason = s.season_number > 0 || monitorSpecials;
							break;
						case 'none':
							shouldMonitorSeason = false;
							break;
						default:
							shouldMonitorSeason = s.season_number > 0 || monitorSpecials;
							break;
					}
				}
			}

			const [newSeason] = await db
				.insert(seasons)
				.values({
					seriesId: newSeries.id,
					seasonNumber: s.season_number,
					monitored: shouldMonitorSeason,
					name: s.name,
					overview: s.overview,
					posterPath: s.poster_path,
					airDate: s.air_date,
					episodeCount: s.episode_count ?? 0,
					episodeFileCount: 0
				})
				.returning();

			try {
				const fullSeason = await tmdb.getSeason(tmdbId, s.season_number);

				if (fullSeason.episodes && fullSeason.episodes.length > 0) {
					const recentCutoffDate = new Date();
					recentCutoffDate.setDate(recentCutoffDate.getDate() - 90);
					const today = new Date();

					const episodeValues = fullSeason.episodes.map((ep) => {
						let shouldMonitorEpisode = shouldMonitorSeason;

						if (selectedEpisodes) {
							shouldMonitorEpisode = selectedEpisodes.has(
								episodeKey(ep.season_number, ep.episode_number)
							);
						} else if (shouldMonitorSeason && !selectedSeasons?.length) {
							const airDate = ep.air_date ? new Date(ep.air_date) : null;
							const hasAired = airDate ? airDate <= today : false;
							const isRecent = airDate ? airDate >= recentCutoffDate : false;

							switch (monitorType) {
								case 'pilot':
									shouldMonitorEpisode = ep.season_number === 1 && ep.episode_number === 1;
									break;
								case 'future':
									shouldMonitorEpisode = !hasAired;
									break;
								case 'recent':
									shouldMonitorEpisode = !hasAired || isRecent;
									break;
								case 'missing':
								case 'existing':
									shouldMonitorEpisode = shouldMonitorSeason;
									break;
								default:
									shouldMonitorEpisode = shouldMonitorSeason;
									break;
							}
						}

						return {
							seriesId: newSeries.id,
							seasonId: newSeason.id,
							tmdbId: ep.id,
							seasonNumber: ep.season_number,
							episodeNumber: ep.episode_number,
							title: ep.name,
							overview: ep.overview,
							airDate: ep.air_date,
							runtime: ep.runtime,
							monitored: shouldMonitorEpisode,
							hasFile: false
						};
					});

					await db.insert(episodes).values(episodeValues);
				}

				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch {
				logger.warn(
					{ seasonNumber: s.season_number },
					'[SeriesAdd] Failed to fetch episodes for season'
				);
			}
		}
	}

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

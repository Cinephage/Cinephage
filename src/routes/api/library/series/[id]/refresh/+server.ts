/**
 * Refresh Series API
 *
 * POST /api/library/series/[id]/refresh
 * Refreshes series metadata and populates all seasons/episodes from TMDB
 *
 * Returns a Server-Sent Events stream with progress updates to keep the
 * connection alive for long-running operations (prevents 502 through reverse proxies)
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSSEOperationStream } from '#lib/server/sse.js';
import { db } from '#lib/server/db/index.js';
import { series, seasons, episodes, episodeFiles } from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { tmdb } from '#lib/server/tmdb.js';
import { todayDateString } from '#lib/utils/format.js';
import {
	enrichAnimeMetadata,
	persistEnrichmentTitleVariants
} from '#lib/server/metadata/provider-resolution.js';
import {
	getEffectiveEpisodeGroup,
	buildSeasonsAndEpisodesFromGroup,
	deleteAllSeasonsAndEpisodes
} from '#lib/server/metadata/EpisodeGroupService.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { resolveLanguage } from '#lib/server/metadata/metadata-refresh.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';
import {
	startRefresh,
	stopRefresh,
	isSeriesRefreshing
} from '#lib/server/library/ActiveSearchTracker.js';

const logger = createChildLogger({ module: 'LibrarySeriesRefreshApi', logDomain: 'scans' });

interface ProgressEvent {
	type: 'progress';
	seasonNumber: number;
	totalSeasons: number;
	message: string;
}

interface CompleteEvent {
	type: 'complete';
	success: true;
	episodeCount: number;
	episodeFileCount: number;
}

interface ErrorEvent {
	type: 'error';
	message: string;
}

type SSEEvent = ProgressEvent | CompleteEvent | ErrorEvent;

export const POST: RequestHandler = async ({ params, request }) => {
	const { id } = params;

	// Get the series
	const [seriesData] = await db.select().from(series).where(eq(series.id, id));

	if (!seriesData) {
		error(404, 'Series not found');
	}

	// Check if a refresh is already running for this series
	if (isSeriesRefreshing(id)) {
		error(409, 'A refresh is already in progress for this series');
	}

	// Track this refresh
	const refreshId = `series-refresh-${id}`;
	startRefresh(refreshId, { seriesId: id });

	return createSSEOperationStream(
		request,
		async ({ send, signal, isAborted }) => {
			const sendEvent = (event: SSEEvent) => {
				if (isAborted()) return;
				send(event.type, event);
			};

			try {
				// Honor the per-series metadata language so a manual full rebuild
				// produces the same localized titles/overviews the background
				// metadata refresh writes. Null keeps the global TMDB default.
				// The persisted original_language avoids a TMDB probe; when it is
				// unknown the probe result is written back (lazy backfill).
				const fetchLanguage = await resolveLanguage(
					seriesData.metadataLanguageMode,
					seriesData.metadataLanguageValue,
					`/tv/${seriesData.tmdbId}`,
					{
						originalLanguage: seriesData.originalLanguage,
						onProbed: async (probed) => {
							await db.update(series).set({ originalLanguage: probed }).where(eq(series.id, id));
							logger.info(
								{ seriesId: id, originalLanguage: probed },
								'[RefreshSeries] Backfilled series original_language'
							);
						}
					}
				);

				// Fetch fresh data from TMDB (canonical identity/overview/genres)
				const [tmdbSeries, externalIds] = await Promise.all([
					tmdb.getTVShow(seriesData.tmdbId, fetchLanguage),
					tmdb.getTvExternalIds(seriesData.tmdbId).catch(() => null)
				]);

				// Determine anime classification from TMDB metadata
				const animeSignal = isLikelyAnimeMedia({
					genres: tmdbSeries.genres,
					originalLanguage: tmdbSeries.original_language,
					originCountries: tmdbSeries.origin_country,
					productionCountries: tmdbSeries.production_countries,
					title: tmdbSeries.name,
					originalTitle: tmdbSeries.original_name
				});
				const isAnime = seriesData.seriesType === 'anime' || animeSignal;

				// Fetch supplementary anime enrichment (alt titles, adult flag) from AniList + Jikan.
				// Runs in parallel; failures are silently skipped.
				const providerRefs = (seriesData.providerRefs ?? {}) as Record<string, string>;
				let adultFromEnrichment = false;
				const adultSources: string[] = [];
				if (isAnime) {
					const enrichment = await enrichAnimeMetadata(
						{
							tmdbTitle: tmdbSeries.name,
							aliases: [
								tmdbSeries.original_name ?? '',
								seriesData.title,
								seriesData.originalTitle ?? ''
							],
							year: tmdbSeries.first_air_date
								? parseInt(tmdbSeries.first_air_date.split('-')[0], 10)
								: seriesData.year
						},
						'anime'
					);
					Object.assign(providerRefs, enrichment.refs);
					for (const [pid, details] of Object.entries(enrichment.details)) {
						if (details.isAdult) {
							adultFromEnrichment = true;
							adultSources.push(pid);
						}
					}
					// Persist AniList/MAL title variants as alternate titles
					// (idempotent; language only when the provider supplies one).
					await persistEnrichmentTitleVariants('series', id, enrichment.details);
				}
				// Sticky-OR: once adult, always adult
				const newAdult = (seriesData.adult ?? false) || adultFromEnrichment;
				const newAdultSource =
					adultSources.length > 0 ? adultSources.join(',') : (seriesData.adultSource ?? null);
				const newAdultConfidence = adultFromEnrichment
					? 'provider'
					: (seriesData.adultConfidence ?? null);

				// Update series metadata - TMDB is canonical for identity/overview/genres
				await db
					.update(series)
					.set({
						posterPath: tmdbSeries.poster_path,
						backdropPath: tmdbSeries.backdrop_path,
						status: tmdbSeries.status,
						network: tmdbSeries.networks?.[0]?.name,
						providerRefs,
						title: tmdbSeries.name,
						originalTitle: tmdbSeries.original_name,
						originalLanguage: tmdbSeries.original_language,
						overview: tmdbSeries.overview,
						year: tmdbSeries.first_air_date
							? parseInt(tmdbSeries.first_air_date.split('-')[0], 10)
							: seriesData.year,
						genres: tmdbSeries.genres?.map((g) => g.name),
						tvdbId: externalIds?.tvdb_id || seriesData.tvdbId,
						imdbId: externalIds?.imdb_id || seriesData.imdbId,
						adult: newAdult,
						adultSource: newAdultSource,
						adultConfidence: newAdultConfidence
					})
					.where(eq(series.id, id));

				// Get the effective episode group and rebuild seasons/episodes
				const { group: episodeGroup, selectedGroupId: newEpisodeGroupId } =
					await getEffectiveEpisodeGroup(seriesData.tmdbId, seriesData.episodeGroupId);

				const episodeGroupChanged = newEpisodeGroupId !== (seriesData.episodeGroupId ?? null);

				if (episodeGroupChanged) {
					await db
						.update(series)
						.set({ episodeGroupId: newEpisodeGroupId })
						.where(eq(series.id, id));
				}

				// Capture (fileId -> episode numbers) before wiping episodes so we can
				// restore episodeFiles links after the rebuild assigns new UUIDs.
				const existingEpFiles = await db
					.select({ id: episodeFiles.id, episodeIds: episodeFiles.episodeIds })
					.from(episodeFiles)
					.where(eq(episodeFiles.seriesId, id));

				const existingEpisodeRows = await db
					.select({
						id: episodes.id,
						seasonNumber: episodes.seasonNumber,
						episodeNumber: episodes.episodeNumber,
						monitored: episodes.monitored
					})
					.from(episodes)
					.where(eq(episodes.seriesId, id));

				const epNumByOldId = new Map(
					existingEpisodeRows.map((e) => [e.id, { s: e.seasonNumber, e: e.episodeNumber }])
				);

				// Per-episode monitored overrides within a season must also survive
				// the rebuild, same reasoning as priorSeasonMonitored below.
				const priorEpisodeMonitored = new Map(
					existingEpisodeRows.map((e) => [`${e.seasonNumber}-${e.episodeNumber}`, e.monitored])
				);
				const fileEpNumbers = new Map(
					existingEpFiles.map((f) => [
						f.id,
						(f.episodeIds ?? []).flatMap((eid) => {
							const ep = epNumByOldId.get(eid);
							return ep ? [ep] : [];
						})
					])
				);

				// Capture each season's current monitored flag before wiping, so the
				// rebuild below can preserve a user's per-season unmonitor choice
				// instead of recomputing it from scratch (which only knows "is this
				// specials" and the series-level monitorSpecials flag, and so was
				// silently re-monitoring every season on every refresh).
				const priorSeasonMonitored = new Map(
					(
						await db
							.select({ seasonNumber: seasons.seasonNumber, monitored: seasons.monitored })
							.from(seasons)
							.where(eq(seasons.seriesId, id))
					).map((s) => [s.seasonNumber, s.monitored])
				);

				// Delete existing seasons/episodes and rebuild
				await deleteAllSeasonsAndEpisodes(id);

				if (episodeGroup) {
					// Use episode group mapping (e.g. TVDB Order)
					const { seasonValues, episodeValues: groupEpisodeValues } =
						buildSeasonsAndEpisodesFromGroup(id, episodeGroup);

					if (seasonValues.length > 0) {
						const monitorSpecials = seriesData.monitorSpecials ?? false;

						// Preserve existing per-season/per-episode monitored choices
						// across the rebuild (see the non-grouped branch below for why).
						for (const sv of seasonValues) {
							const prior = priorSeasonMonitored.get(sv.seasonNumber!);
							if (prior !== undefined) sv.monitored = prior;
						}
						for (const ev of groupEpisodeValues) {
							const prior = priorEpisodeMonitored.get(`${ev.seasonNumber}-${ev.episodeNumber}`);
							if (prior !== undefined) ev.monitored = prior;
						}

						// Respect monitorSpecials setting for season 0 seasons/episodes
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
					// Default TMDB ordering
					if (tmdbSeries.seasons) {
						for (const tmdbSeasonInfo of tmdbSeries.seasons) {
							if (signal.aborted) return;

							try {
								const tmdbSeason = await tmdb.getSeason(
									seriesData.tmdbId,
									tmdbSeasonInfo.season_number,
									fetchLanguage
								);

								const isSpecials = tmdbSeasonInfo.season_number === 0;
								const monitorSpecials = seriesData.monitorSpecials ?? false;
								// Preserve the user's existing per-season choice across a
								// refresh rebuild; only fall back to the computed default
								// for a season that didn't exist before (newly added by
								// TMDB). Previously this always recomputed from scratch,
								// silently re-monitoring every unmonitored season on every refresh.
								const seasonMonitored =
									priorSeasonMonitored.get(tmdbSeasonInfo.season_number) ??
									(!isSpecials || monitorSpecials);

								const [newSeason] = await db
									.insert(seasons)
									.values({
										seriesId: id,
										seasonNumber: tmdbSeasonInfo.season_number,
										name: tmdbSeason.name || tmdbSeasonInfo.name,
										overview: tmdbSeason.overview || tmdbSeasonInfo.overview,
										posterPath: tmdbSeason.poster_path || tmdbSeasonInfo.poster_path,
										airDate: tmdbSeason.air_date || tmdbSeasonInfo.air_date,
										episodeCount: tmdbSeason.episodes?.length ?? tmdbSeasonInfo.episode_count ?? 0,
										episodeFileCount: 0,
										monitored: seasonMonitored
									})
									.returning();

								if (tmdbSeason.episodes) {
									const episodeValues = tmdbSeason.episodes.map((ep) => ({
										seriesId: id,
										seasonId: newSeason.id,
										tmdbId: ep.id,
										seasonNumber: ep.season_number,
										episodeNumber: ep.episode_number,
										title: ep.name,
										overview: ep.overview,
										airDate: ep.air_date,
										runtime: ep.runtime,
										monitored:
											priorEpisodeMonitored.get(`${ep.season_number}-${ep.episode_number}`) ??
											seasonMonitored,
										hasFile: false
									}));

									if (episodeValues.length > 0) {
										await db.insert(episodes).values(episodeValues);
									}
								}

								await new Promise((resolve) => setTimeout(resolve, 100));
							} catch {
								logger.warn(
									{ seasonNumber: tmdbSeasonInfo.season_number },
									'[RefreshSeries] Failed to fetch season'
								);
							}
						}
					}
				}

				// Re-link episodeFiles to new episode UUIDs by matching season/episode number.
				// deleteAllSeasonsAndEpisodes wiped the old UUIDs so episodeFiles.episodeIds
				// would otherwise point at non-existent rows, making every file appear missing.
				if (fileEpNumbers.size > 0) {
					const newEpisodeRows = await db
						.select({
							id: episodes.id,
							seasonNumber: episodes.seasonNumber,
							episodeNumber: episodes.episodeNumber
						})
						.from(episodes)
						.where(eq(episodes.seriesId, id));

					const newIdByKey = new Map(
						newEpisodeRows.map((e) => [`${e.seasonNumber}-${e.episodeNumber}`, e.id])
					);

					const linkedEpisodeIds = new Set<string>();
					for (const [fileId, epNums] of fileEpNumbers) {
						const newIds = epNums
							.map(({ s, e }) => newIdByKey.get(`${s}-${e}`))
							.filter((eid): eid is string => eid !== undefined);

						await db
							.update(episodeFiles)
							.set({ episodeIds: newIds.length > 0 ? newIds : null })
							.where(eq(episodeFiles.id, fileId));

						newIds.forEach((eid) => linkedEpisodeIds.add(eid));
					}

					if (linkedEpisodeIds.size > 0) {
						await db
							.update(episodes)
							.set({ hasFile: true })
							.where(inArray(episodes.id, [...linkedEpisodeIds]));
					}
				}

				// Update series episode counts (include specials if monitorSpecials is enabled)
				const allEpisodes = await db.select().from(episodes).where(eq(episodes.seriesId, id));
				const monitorSpecials = seriesData.monitorSpecials ?? false;
				const today = todayDateString();
				const isAired = (episode: typeof episodes.$inferSelect) =>
					episode.airDate && episode.airDate !== '' && episode.airDate <= today;

				const episodesForStats = allEpisodes.filter(
					(e) => isAired(e) && (monitorSpecials || e.seasonNumber !== 0)
				);
				const episodeCount = episodesForStats.length;
				const episodeFileCount = episodesForStats.filter((e) => e.hasFile).length;

				await db.update(series).set({ episodeCount, episodeFileCount }).where(eq(series.id, id));

				// Update each season's episode counts (only aired episodes)
				const seasonEpisodeCounts = new Map<string, { total: number; withFiles: number }>();
				for (const ep of allEpisodes) {
					if (!isAired(ep)) continue;
					if (ep.seasonId) {
						const current = seasonEpisodeCounts.get(ep.seasonId) || { total: 0, withFiles: 0 };
						current.total++;
						if (ep.hasFile) current.withFiles++;
						seasonEpisodeCounts.set(ep.seasonId, current);
					}
				}

				for (const [seasonId, counts] of seasonEpisodeCounts) {
					await db
						.update(seasons)
						.set({
							episodeCount: counts.total,
							episodeFileCount: counts.withFiles
						})
						.where(eq(seasons.id, seasonId));
				}

				libraryMediaEvents.emitSeriesUpdated(id);

				// Send completion event
				sendEvent({
					type: 'complete',
					success: true,
					episodeCount,
					episodeFileCount
				});
			} catch (err) {
				logger.error(
					'[RefreshSeries] Failed to refresh series',
					err instanceof Error ? err : undefined
				);
				sendEvent({
					type: 'error',
					message: err instanceof Error ? err.message : 'Failed to refresh series from TMDB'
				});
			} finally {
				stopRefresh(refreshId);
			}
		},
		{ heartbeatInterval: 25000 }
	);
};

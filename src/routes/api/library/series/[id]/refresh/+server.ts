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
	buildDefaultOrderingPlan,
	persistEpisodePlan,
	resolveEpisodeGroupPlan,
	type SeriesEpisodePlan
} from '#lib/server/metadata/series-episode-plan.js';
import { getLibraryScheduler } from '#lib/server/library/library-scheduler.js';
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
	/** Non-fatal conditions the user should know about (surfaces in the UI). */
	warning?: string;
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

				// Resolve the ordering plan before anything destructive. The scheme
				// is stable across refreshes: a stored group that cannot be fetched
				// leaves the current rows untouched, and an unusable one falls back
				// to default TMDB ordering instead of wiping into a broken series.
				const resolution = await resolveEpisodeGroupPlan({
					seriesId: id,
					tmdbId: seriesData.tmdbId,
					storedEpisodeGroupId: seriesData.episodeGroupId,
					selection: 'stored-only'
				});

				if (resolution.kind === 'group-unavailable') {
					const [current] = await db
						.select({
							episodeCount: series.episodeCount,
							episodeFileCount: series.episodeFileCount
						})
						.from(series)
						.where(eq(series.id, id));
					sendEvent({
						type: 'complete',
						success: true,
						episodeCount: current?.episodeCount ?? 0,
						episodeFileCount: current?.episodeFileCount ?? 0,
						warning:
							'Metadata was refreshed, but episode data was left unchanged: the episode group could not be fetched from TMDB. Try again later to keep the current numbering.'
					});
					return;
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

				const monitorSpecials = seriesData.monitorSpecials ?? false;
				const fallbackReason =
					resolution.kind === 'default-ordering' ? resolution.fallbackReason : undefined;
				const failedSeasonNumbers: number[] = [];
				let rebuildPlan: SeriesEpisodePlan;
				if (resolution.kind === 'episode-group') {
					rebuildPlan = resolution.plan;
					// Preserve existing per-season/per-episode monitored choices
					// across the rebuild instead of recomputing from scratch (which
					// only knows "is this specials" and the series-level
					// monitorSpecials flag, and so silently re-monitored every season
					// the user had explicitly turned off).
					for (const sv of rebuildPlan.seasons) {
						const prior = priorSeasonMonitored.get(sv.seasonNumber ?? Number.NaN);
						if (prior !== undefined) sv.monitored = prior;
					}
					for (const ev of rebuildPlan.episodes) {
						const prior = priorEpisodeMonitored.get(`${ev.seasonNumber}-${ev.episodeNumber}`);
						if (prior !== undefined) ev.monitored = prior;
					}
					// Respect monitorSpecials setting for season 0 seasons/episodes
					if (monitorSpecials) {
						for (const sv of rebuildPlan.seasons) {
							if (sv.seasonNumber === 0) sv.monitored = true;
						}
						for (const ev of rebuildPlan.episodes) {
							if (ev.seasonNumber === 0) ev.monitored = true;
						}
					}
				} else {
					if (fallbackReason) {
						logger.warn(
							{ seriesId: id, tmdbId: seriesData.tmdbId, reason: fallbackReason },
							'[RefreshSeries] Episode group unusable; rebuilding with default TMDB ordering'
						);
					}
					// A group -> default fallback renumbers the series; clear the
					// stored group so future refreshes stay stable under default.
					if (seriesData.episodeGroupId) {
						await db.update(series).set({ episodeGroupId: null }).where(eq(series.id, id));
					}
					const built = await buildDefaultOrderingPlan({
						seriesId: id,
						seasonsSummary: tmdbSeries.seasons ?? [],
						fetchSeason: (seasonNumber) =>
							tmdb.getSeason(seriesData.tmdbId, seasonNumber, fetchLanguage),
						assignSeasonMonitored: (seasonNumber, isSpecials) =>
							priorSeasonMonitored.get(seasonNumber) ?? (!isSpecials || monitorSpecials),
						assignEpisodeMonitored: ({ seasonNumber, episodeNumber, seasonMonitored }) =>
							priorEpisodeMonitored.get(`${seasonNumber}-${episodeNumber}`) ?? seasonMonitored,
						paceMs: 100
					});
					rebuildPlan = built.plan;
					failedSeasonNumbers.push(...built.failedSeasonNumbers);
					if (built.failedSeasonNumbers.length > 0) {
						logger.warn(
							{ seriesId: id, failedSeasonNumbers: built.failedSeasonNumbers },
							'[RefreshSeries] Some seasons had no fetchable episode list'
						);
					}
				}

				if (signal.aborted) return;

				// Rebuild atomically: the wipe commits together with the
				// replacements, so a failure anywhere leaves the previous rows
				// intact instead of a half-rebuilt series.
				persistEpisodePlan(id, rebuildPlan, { wipe: true });

				// A group -> default fallback renumbers the series; queue a rescan
				// so existing files re-match under the new numbering.
				if (
					resolution.kind === 'default-ordering' &&
					seriesData.episodeGroupId &&
					fileEpNumbers.size > 0 &&
					seriesData.rootFolderId
				) {
					getLibraryScheduler().queueFolderScan(seriesData.rootFolderId);
				}

				// Re-link episodeFiles to new episode UUIDs by matching season/episode number.
				// The transactional wipe removed the old UUIDs so
				// episodeFiles.episodeIds would otherwise point at non-existent
				// rows, making every file appear missing.
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

				// Surface non-fatal conditions so a degraded refresh is visible
				// instead of silently looking like a clean one.
				const warnings: string[] = [];
				if (fallbackReason) {
					warnings.push(
						'Episode data was rebuilt with default TMDB ordering because the episode group was unusable.'
					);
				}
				if (failedSeasonNumbers.length > 0) {
					warnings.push(
						`Some seasons had no fetchable episode list and may be incomplete: ${failedSeasonNumbers.join(', ')}.`
					);
				}

				// Send completion event
				sendEvent({
					type: 'complete',
					success: true,
					episodeCount,
					episodeFileCount,
					warning: warnings.length > 0 ? warnings.join(' ') : undefined
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

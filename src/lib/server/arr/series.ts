/**
 * Sonarr-compatible `series` (library listing/detail) and `series/lookup`
 * (TMDB search for not-yet-added series) responses.
 *
 * Field set confirmed against SeriesResource (and its sub-resources -
 * SeasonResource, SeasonStatisticsResource, SeriesStatisticsResource,
 * AlternativeTitleResource, MediaCover) in Sonarr's actual openapi.json.
 * Fields with no real Cinephage source get honest neutral defaults, same
 * convention as movies.ts.
 */

import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	series,
	seasons,
	episodes,
	episodeFiles,
	alternateTitles,
	rootFolders
} from '#lib/server/db/schema.js';
import { getOrAssignArrId, getOrAssignArrIds } from './ArrIdMappingService.js';
import {
	cleanTitleFor,
	titleSlugFor,
	folderNameFor,
	buildMovieImages,
	tmdbPosterUrl
} from './movieShape.js';
import { deriveSeriesStatus } from './seriesShape.js';
import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

type SeriesRow = typeof series.$inferSelect;
type SeasonRow = typeof seasons.$inferSelect;

async function buildAlternateTitles(seriesId: string) {
	const rows = await db
		.select()
		.from(alternateTitles)
		.where(eq(alternateTitles.mediaType, 'series'));
	return rows
		.filter((row) => row.mediaId === seriesId)
		.map((row) => ({
			id: row.id,
			sourceType: row.source === 'tmdb' ? 'tmdb' : 'user',
			title: row.title,
			cleanTitle: row.cleanTitle
		}));
}

async function buildSeasonResources(
	seriesId: string,
	seasonRows: SeasonRow[]
): Promise<Record<string, unknown>[]> {
	const episodeRows = await db.select().from(episodes).where(eq(episodes.seriesId, seriesId));
	const fileRows = await db.select().from(episodeFiles).where(eq(episodeFiles.seriesId, seriesId));

	return seasonRows.map((season) => {
		const seasonEpisodes = episodeRows.filter((e) => e.seasonNumber === season.seasonNumber);
		// Compute from the real episodes/episode_files rows rather than the
		// season's cached counters - those default to 0 and go stale, they
		// aren't a reliable source of truth here. episodeFileCount counts
		// episodes with a file, not file rows - one file can cover multiple
		// episodes (double episodes, season packs), so counting file rows
		// would undercount.
		const totalEpisodeCount = seasonEpisodes.length;
		const episodeCount = seasonEpisodes.filter((e) => e.monitored).length;
		const episodeFileCount = seasonEpisodes.filter((e) => e.hasFile).length;
		const sizeOnDisk = fileRows
			.filter((f) => f.seasonNumber === season.seasonNumber)
			.reduce((sum, f) => sum + (f.size ?? 0), 0);

		return {
			seasonNumber: season.seasonNumber,
			monitored: !!season.monitored,
			statistics: {
				nextAiring: null,
				previousAiring: null,
				episodeFileCount,
				episodeCount,
				totalEpisodeCount,
				sizeOnDisk,
				releaseGroups: [
					...new Set(
						fileRows
							.filter((f) => f.seasonNumber === season.seasonNumber && f.releaseGroup)
							.map((f) => f.releaseGroup as string)
					)
				],
				percentOfEpisodes: totalEpisodeCount > 0 ? (episodeFileCount / totalEpisodeCount) * 100 : 0
			},
			images: season.posterPath ? buildMovieImages(season.posterPath, null) : []
		};
	});
}

async function loadRootFolderPaths(rootFolderIds: string[]): Promise<Map<string, string>> {
	if (rootFolderIds.length === 0) return new Map();
	const rows = await db
		.select({ id: rootFolders.id, path: rootFolders.path })
		.from(rootFolders)
		.where(inArray(rootFolders.id, rootFolderIds));
	return new Map(rows.map((r) => [r.id, r.path]));
}

async function seriesToResource(
	row: SeriesRow,
	seriesArrId: number,
	qualityProfileArrId: number | null,
	rootFolderPath: string | null
): Promise<Record<string, unknown>> {
	const seasonRows = await db.select().from(seasons).where(eq(seasons.seriesId, row.id));
	const seasonResources = await buildSeasonResources(row.id, seasonRows);
	// Sum from the same per-season stats just computed, rather than the
	// series row's own cached counters - same staleness risk as the
	// per-season fix above.
	interface SeriesStatsAccumulator {
		episodeCount: number;
		episodeFileCount: number;
		totalEpisodeCount: number;
		sizeOnDisk: number;
	}
	const seriesStats = seasonResources.reduce<SeriesStatsAccumulator>(
		(acc, s) => {
			const stats = (s as { statistics: SeriesStatsAccumulator }).statistics;
			acc.episodeCount += stats.episodeCount;
			acc.episodeFileCount += stats.episodeFileCount;
			acc.totalEpisodeCount += stats.totalEpisodeCount;
			acc.sizeOnDisk += stats.sizeOnDisk;
			return acc;
		},
		{ episodeCount: 0, episodeFileCount: 0, totalEpisodeCount: 0, sizeOnDisk: 0 }
	);

	return {
		id: seriesArrId,
		title: row.title,
		alternateTitles: await buildAlternateTitles(row.id),
		sortTitle: cleanTitleFor(row.title),
		status: deriveSeriesStatus(row.status),
		ended: row.status === 'Ended',
		overview: row.overview ?? '',
		nextAiring: null,
		previousAiring: null,
		network: row.network,
		images: buildMovieImages(row.posterPath, row.backdropPath),
		originalLanguage: { id: 1, name: 'English' },
		remotePoster: tmdbPosterUrl(row.posterPath),
		seasons: seasonResources,
		year: row.year ?? 0,
		path: row.path,
		qualityProfileId: qualityProfileArrId ?? 0,
		seasonFolder: !!row.seasonFolder,
		monitored: !!row.monitored,
		monitorNewItems: row.monitorNewItems === 'none' ? 'none' : 'all',
		useSceneNumbering: false,
		runtime: 0,
		tvdbId: row.tvdbId ?? 0,
		tvRageId: 0,
		tvMazeId: 0,
		tmdbId: row.tmdbId,
		firstAired: row.firstAirDate,
		lastAired: null,
		seriesType: row.seriesType ?? 'standard',
		cleanTitle: cleanTitleFor(row.title),
		imdbId: row.imdbId,
		titleSlug: titleSlugFor(row.tmdbId),
		rootFolderPath,
		folder: folderNameFor(row.path),
		certification: null,
		genres: row.genres ?? [],
		tags: [],
		added: row.added,
		ratings: {},
		statistics: {
			seasonCount: seasonRows.length,
			episodeFileCount: seriesStats.episodeFileCount,
			episodeCount: seriesStats.episodeCount,
			totalEpisodeCount: seriesStats.totalEpisodeCount,
			sizeOnDisk: seriesStats.sizeOnDisk,
			releaseGroups: [],
			percentOfEpisodes:
				seriesStats.totalEpisodeCount > 0
					? (seriesStats.episodeFileCount / seriesStats.totalEpisodeCount) * 100
					: 0
		},
		episodesChanged: false,
		languageProfileId: 1
	};
}

export async function buildSeries(): Promise<Record<string, unknown>[]> {
	const rows = await db.select().from(series).orderBy(desc(series.added));

	const seriesArrIds = await getOrAssignArrIds(
		'series',
		rows.map((r) => r.id)
	);
	const profileIds = [
		...new Set(rows.map((r) => r.scoringProfileId).filter((id) => !!id))
	] as string[];
	const profileArrIds = await getOrAssignArrIds('qualityProfile', profileIds);
	const rootFolderIds = [
		...new Set(rows.map((r) => r.rootFolderId).filter((id) => !!id))
	] as string[];
	const rootFolderPaths = await loadRootFolderPaths(rootFolderIds);

	return Promise.all(
		rows.map((row) =>
			seriesToResource(
				row,
				seriesArrIds.get(row.id)!,
				row.scoringProfileId ? (profileArrIds.get(row.scoringProfileId) ?? null) : null,
				row.rootFolderId ? (rootFolderPaths.get(row.rootFolderId) ?? null) : null
			)
		)
	);
}

export async function buildSeriesByArrId(
	seriesArrId: number
): Promise<Record<string, unknown> | null> {
	const all = await buildSeries();
	return all.find((s) => s.id === seriesArrId) ?? null;
}

/**
 * Real Sonarr's `term` also accepts `tmdb:<id>` and `imdb:<id>` as a
 * direct-ID lookup instead of a free-text search - see movies.ts
 * buildMovieLookup for why this matters: arr clients check for an
 * existing library entry via exactly this syntax on every add, and Sonarr
 * (unlike Radarr) has no separate `/series/lookup/tmdb` endpoint at all,
 * so this prefix is the *only* way a client can look up by ID here.
 */
export async function buildSeriesLookup(term: string): Promise<Record<string, unknown>[]> {
	const tmdbMatch = /^tmdb:(\d+)$/i.exec(term);
	if (tmdbMatch) {
		const show = await buildSeriesLookupByTmdbId(Number(tmdbMatch[1]));
		return show ? [show] : [];
	}

	const imdbMatch = /^imdb:(tt\d+)$/i.exec(term);
	if (imdbMatch) {
		const found = await tmdb.findByExternalId(imdbMatch[1], 'imdb_id');
		const tmdbId = found.tv_results?.[0]?.id;
		if (!tmdbId) return [];
		const show = await buildSeriesLookupByTmdbId(tmdbId);
		return show ? [show] : [];
	}

	// Sonarr's own identity key is TVDB, not TMDB - Seerr's addSeries() always
	// looks a series up by `tvdb:<id>` first (its own getSeriesByTvdbId),
	// before ever calling POST /series. Without this, that lookup silently
	// falls through to a TMDB title search for the literal string
	// "tvdb:12345", which never matches anything - Seerr sees an empty
	// array and reports "series not found", with nothing to log on our side
	// since nothing actually failed.
	const tvdbMatch = /^tvdb:(\d+)$/i.exec(term);
	if (tvdbMatch) {
		const tvdbId = Number(tvdbMatch[1]);
		const [existing] = await db
			.select({ id: series.id })
			.from(series)
			.where(eq(series.tvdbId, tvdbId))
			.limit(1);
		if (existing) {
			const arrId = await getOrAssignArrId('series', existing.id);
			const show = await buildSeriesByArrId(arrId);
			return show ? [show] : [];
		}

		const found = await tmdb.findByExternalId(String(tvdbId), 'tvdb_id');
		const tmdbId = found.tv_results?.[0]?.id;
		if (!tmdbId) return [];
		const show = await buildSeriesLookupByTmdbId(tmdbId);
		return show ? [show] : [];
	}

	const result = await tmdb.searchTv(term);
	return result.results.map((show) => {
		const year = show.first_air_date ? Number.parseInt(show.first_air_date.slice(0, 4), 10) : 0;
		return {
			id: 0,
			title: show.name ?? show.title ?? '',
			sortTitle: cleanTitleFor(show.name ?? ''),
			status: 'continuing',
			overview: show.overview ?? '',
			images: buildMovieImages(show.poster_path, null),
			remotePoster: tmdbPosterUrl(show.poster_path),
			seasons: [],
			year: year || 0,
			tmdbId: show.id,
			titleSlug: titleSlugFor(show.id),
			cleanTitle: cleanTitleFor(show.name ?? ''),
			genres: [],
			ratings: { tmdb: { votes: 0, value: show.vote_average ?? 0, type: 'user' } },
			monitored: false,
			added: null
		};
	});
}

export async function buildSeriesLookupByTmdbId(
	tmdbId: number
): Promise<Record<string, unknown> | null> {
	// See movies.ts buildMovieLookupByTmdbId - real Sonarr returns the real
	// library entry here when one already exists, not always a "not yet
	// added" template.
	const [existing] = await db
		.select({ id: series.id })
		.from(series)
		.where(eq(series.tmdbId, tmdbId))
		.limit(1);
	if (existing) {
		const arrId = await getOrAssignArrId('series', existing.id);
		return buildSeriesByArrId(arrId);
	}

	try {
		const details = await tmdb.getTVShow(tmdbId);
		return {
			id: 0,
			title: details.name,
			sortTitle: cleanTitleFor(details.name),
			status: deriveSeriesStatus(
				details.status === 'Returning Series' ? 'Continuing' : (details.status as string)
			),
			overview: details.overview ?? '',
			images: buildMovieImages(details.poster_path, details.backdrop_path),
			remotePoster: tmdbPosterUrl(details.poster_path),
			seasons: [],
			year: details.first_air_date ? Number.parseInt(details.first_air_date.slice(0, 4), 10) : 0,
			tmdbId: details.id,
			titleSlug: titleSlugFor(details.id),
			cleanTitle: cleanTitleFor(details.name),
			genres: (details.genres ?? []).map((g) => g.name),
			ratings: { tmdb: { votes: 0, value: details.vote_average ?? 0, type: 'user' } },
			monitored: false,
			added: null
		};
	} catch (err) {
		// See movies.ts buildMovieLookupByTmdbId for why this distinguishes a
		// genuine TMDB 404 from every other failure instead of swallowing
		// both into the same misleading "Series not found".
		const message = err instanceof Error ? err.message : String(err);
		if (/TMDB Error: 404/.test(message)) {
			return null;
		}
		logger.error({ tmdbId, err: message }, '[arr-compat] series lookup by tmdbId failed');
		throw err;
	}
}

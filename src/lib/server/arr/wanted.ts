/**
 * Radarr/Sonarr-compatible `wanted/missing` and `wanted/cutoff` responses.
 *
 * `wanted/missing` reuses the same Movie/Episode resources already built
 * for /movie and /episode, filtered to monitored + already-aired + no
 * file - real, useful data.
 *
 * `wanted/cutoff` (quality-cutoff-unmet) mirrors the same resolution-ordinal
 * comparison as Cinephage's own QualityBelowCutoffRule (storage insights) -
 * a file's resolution below its scoring profile's minResolution - inlined
 * here directly against real movie/series rows rather than reusing that
 * rule's own output, since its aggregated finding shape only carries
 * tmdbId (ambiguous between movies and episodes, no clean way back to the
 * real UUID this layer needs).
 */

import { sql } from 'drizzle-orm';
import { buildMovies } from './movies.js';
import { buildEpisodesForSeries } from './episodes.js';
import { db } from '#lib/server/db/index.js';
import {
	series,
	movies,
	movieFiles,
	episodeFiles,
	scoringProfiles
} from '#lib/server/db/schema.js';
import { getOrAssignArrIds } from './ArrIdMappingService.js';
import type { ArrAppName } from './systemStatus.js';

// Matches QualityBelowCutoffRule.ts - kept in sync manually since neither
// side depends on the other (storage insights vs. arr-compat are separate
// concerns that happen to use the same resolution scale).
const RESOLUTION_ORDER: Record<string, number> = {
	'2160p': 4,
	'1080p': 3,
	'720p': 2,
	'480p': 1,
	unknown: 0
};

function resolutionOrdinal(resolution: string | null | undefined): number {
	return RESOLUTION_ORDER[resolution ?? 'unknown'] ?? 0;
}

interface PagingOptions {
	page: number;
	pageSize: number;
	sortKey: string | null;
	sortDirection: string;
}

function paginate<T>(records: T[], options: PagingOptions) {
	const totalRecords = records.length;
	const page = Math.max(1, options.page);
	const pageSize = Math.max(1, options.pageSize);
	return {
		page,
		pageSize,
		sortKey: options.sortKey,
		sortDirection: options.sortDirection,
		totalRecords,
		records: records.slice((page - 1) * pageSize, page * pageSize)
	};
}

function hasAired(dateStr: string | null | undefined): boolean {
	if (!dateStr) return false;
	const t = new Date(dateStr).getTime();
	return !Number.isNaN(t) && t <= Date.now();
}

export async function buildWantedMissing(appName: ArrAppName, options: PagingOptions) {
	if (appName === 'Radarr') {
		const movies = await buildMovies();
		const missing = movies.filter(
			(m) => m.monitored && !m.hasFile && hasAired(m.releaseDate as string | null)
		);
		return paginate(missing, options);
	}

	const allSeries = await db.select({ id: series.id }).from(series);
	const allEpisodes = (
		await Promise.all(allSeries.map((s) => buildEpisodesForSeries({ seriesId: s.id })))
	).flat();
	const missing = allEpisodes.filter(
		(e) => e.monitored && !e.hasFile && hasAired(e.airDate as string | null)
	);
	return paginate(missing, options);
}

export async function buildWantedCutoff(appName: ArrAppName, options: PagingOptions) {
	if (appName === 'Radarr') {
		const movieResources = await buildMovies();
		const movieResourceById = new Map(movieResources.map((m) => [m.id, m]));

		// Best file per movie, same multi-quality-mode handling as
		// QualityBelowCutoffRule: only the highest-resolution file counts.
		const rows = db
			.select({
				movieId: movies.id,
				resolution: sql<string>`json_extract(${movieFiles.quality}, '$.resolution')`,
				minResolution: scoringProfiles.minResolution
			})
			.from(movies)
			.innerJoin(movieFiles, sql`${movieFiles.movieId} = ${movies.id}`)
			.leftJoin(scoringProfiles, sql`${scoringProfiles.id} = ${movies.scoringProfileId}`)
			.all();

		const bestOrdinalByMovie = new Map<string, number>();
		for (const row of rows) {
			const ordinal = resolutionOrdinal(row.resolution);
			bestOrdinalByMovie.set(
				row.movieId,
				Math.max(ordinal, bestOrdinalByMovie.get(row.movieId) ?? -1)
			);
		}
		const minResolutionByMovie = new Map(rows.map((r) => [r.movieId, r.minResolution]));

		const movieArrIds = await getOrAssignArrIds('movie', [...bestOrdinalByMovie.keys()]);
		const belowCutoff = [...bestOrdinalByMovie.entries()]
			.filter(([movieId, ordinal]) => {
				const minResolution = minResolutionByMovie.get(movieId);
				return !!minResolution && ordinal < resolutionOrdinal(minResolution);
			})
			.map(([movieId]) => movieResourceById.get(movieArrIds.get(movieId)!))
			.filter((m): m is NonNullable<typeof m> => !!m);

		return paginate(belowCutoff, options);
	}

	const allSeries = await db.select({ id: series.id }).from(series);
	const episodeResources = (
		await Promise.all(allSeries.map((s) => buildEpisodesForSeries({ seriesId: s.id })))
	).flat();
	// episodeFile.id on the built resource is the surrogate arr ID, not the
	// raw UUID - index by that so it lines up with the arr IDs resolved below.
	const episodeResourceByFileArrId = new Map<number, (typeof episodeResources)[number]>();
	for (const episode of episodeResources) {
		const fileArrId = (episode.episodeFile as { id: number } | undefined)?.id;
		if (fileArrId !== undefined) episodeResourceByFileArrId.set(fileArrId, episode);
	}

	const episodeFileRows = db
		.select({
			id: episodeFiles.id,
			resolution: sql<string>`json_extract(${episodeFiles.quality}, '$.resolution')`,
			minResolution: scoringProfiles.minResolution
		})
		.from(episodeFiles)
		.leftJoin(series, sql`${series.id} = ${episodeFiles.seriesId}`)
		.leftJoin(scoringProfiles, sql`${scoringProfiles.id} = ${series.scoringProfileId}`)
		.all();

	const belowCutoffFileIds = episodeFileRows
		.filter(
			(row) =>
				row.minResolution &&
				resolutionOrdinal(row.resolution) < resolutionOrdinal(row.minResolution)
		)
		.map((row) => row.id);

	const fileArrIds = await getOrAssignArrIds('episodeFile', belowCutoffFileIds);
	const belowCutoffEpisodes = belowCutoffFileIds
		.map((fileId) => episodeResourceByFileArrId.get(fileArrIds.get(fileId)!))
		.filter((e): e is NonNullable<typeof e> => !!e);

	return paginate(belowCutoffEpisodes, options);
}

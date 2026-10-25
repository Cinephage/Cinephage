/**
 * Radarr-compatible `movie` (library listing/detail) and `movie/lookup`
 * (TMDB search for not-yet-added movies) responses.
 *
 * Field set confirmed against MovieResource (and its sub-resources -
 * MovieFileResource, MovieCollectionResource, MovieStatisticsResource,
 * AlternativeTitleResource, MediaCover) in Radarr's actual openapi.json.
 * Fields with no real Cinephage source (studio, website, youTubeTrailerId,
 * certification, keywords, per-provider ratings breakdown beyond TMDB) get
 * honest neutral defaults (null/[]/0) rather than fabricated data.
 */

import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { movies, movieFiles, alternateTitles, rootFolders } from '#lib/server/db/schema.js';
import { getOrAssignArrId, getOrAssignArrIds } from './ArrIdMappingService.js';
import {
	deriveMovieStatus,
	cleanTitleFor,
	titleSlugFor,
	folderNameFor,
	buildMovieImages,
	tmdbPosterUrl
} from './movieShape.js';
import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

type MovieRow = typeof movies.$inferSelect;
type MovieFileRow = typeof movieFiles.$inferSelect;

async function buildAlternateTitles(movieId: string) {
	const rows = await db
		.select()
		.from(alternateTitles)
		.where(eq(alternateTitles.mediaType, 'movie'));
	return rows
		.filter((row) => row.mediaId === movieId)
		.map((row) => ({
			id: row.id,
			sourceType: row.source === 'tmdb' ? 'tmdb' : 'user',
			movieMetadataId: 0,
			title: row.title,
			cleanTitle: row.cleanTitle
		}));
}

function buildMovieFileResource(
	file: MovieFileRow,
	fileArrId: number,
	movieArrId: number
): Record<string, unknown> {
	const resolution = file.quality?.resolution
		? Number.parseInt(file.quality.resolution, 10) || 0
		: 0;
	return {
		id: fileArrId,
		movieId: movieArrId,
		relativePath: file.relativePath,
		path: file.relativePath,
		size: file.size ?? 0,
		dateAdded: file.dateAdded,
		sceneName: file.sceneName,
		releaseGroup: file.releaseGroup,
		edition: file.edition ?? '',
		languages: (file.languages ?? []).map((name, i) => ({ id: i + 1, name })),
		quality: {
			quality: { id: 1, name: file.quality?.resolution ?? 'Unknown', resolution },
			revision: { version: 1, real: 0, isRepack: false }
		},
		customFormats: [],
		customFormatScore: 0,
		indexerFlags: 0,
		mediaInfo: file.mediaInfo
			? {
					audioBitrate: file.mediaInfo.audioBitrate ?? 0,
					audioChannels: file.mediaInfo.audioChannels ?? 0,
					audioCodec: file.mediaInfo.audioCodec ?? null,
					audioLanguages: file.mediaInfo.audioLanguages ?? [],
					videoBitDepth: file.mediaInfo.videoBitDepth ?? 0,
					videoBitrate: file.mediaInfo.videoBitrate ?? 0,
					videoCodec: file.mediaInfo.videoCodec ?? null,
					videoFps: file.mediaInfo.fps ?? 0,
					videoDynamicRange: file.mediaInfo.videoHdrFormat ? 'HDR' : 'SDR',
					resolution:
						file.mediaInfo.width && file.mediaInfo.height
							? `${file.mediaInfo.width}x${file.mediaInfo.height}`
							: null,
					runTime: file.mediaInfo.runtime ?? null,
					subtitles: (file.mediaInfo.subtitleLanguages ?? []).join(', ')
				}
			: null,
		originalFilePath: null,
		qualityCutoffNotMet: false
	};
}

async function movieToResource(
	row: MovieRow,
	file: MovieFileRow | undefined,
	movieArrId: number,
	qualityProfileArrId: number | null,
	rootFolderPath: string | null
): Promise<Record<string, unknown>> {
	const fileArrId = file ? await getOrAssignArrId('movieFile', file.id) : null;

	return {
		id: movieArrId,
		title: row.title,
		originalTitle: row.originalTitle ?? row.title,
		originalLanguage: { id: 1, name: 'English' },
		alternateTitles: await buildAlternateTitles(row.id),
		secondaryYear: null,
		secondaryYearSourceId: 0,
		sortTitle: cleanTitleFor(row.title),
		sizeOnDisk: file?.size ?? 0,
		status: deriveMovieStatus(row),
		overview: row.overview ?? '',
		inCinemas: row.releaseDate,
		physicalRelease: row.physicalReleaseDate,
		digitalRelease: row.digitalReleaseDate,
		releaseDate: row.releaseDate,
		physicalReleaseNote: null,
		images: buildMovieImages(row.posterPath, row.backdropPath),
		website: null,
		remotePoster: tmdbPosterUrl(row.posterPath),
		year: row.year ?? 0,
		youTubeTrailerId: null,
		studio: null,
		path: row.path,
		qualityProfileId: qualityProfileArrId ?? 0,
		hasFile: !!row.hasFile,
		movieFileId: fileArrId ?? 0,
		monitored: !!row.monitored,
		minimumAvailability: row.minimumAvailability ?? 'released',
		isAvailable: !!row.hasFile || deriveMovieStatus(row) === 'released',
		folderName: folderNameFor(row.path),
		runtime: row.runtime ?? 0,
		cleanTitle: cleanTitleFor(row.title),
		imdbId: row.imdbId,
		tmdbId: row.tmdbId,
		titleSlug: titleSlugFor(row.tmdbId),
		rootFolderPath,
		folder: folderNameFor(row.path),
		certification: null,
		genres: row.genres ?? [],
		keywords: [],
		tags: [],
		added: row.added,
		ratings: {},
		...(file ? { movieFile: buildMovieFileResource(file, fileArrId!, movieArrId) } : {}),
		...(row.tmdbCollectionId
			? { collection: { title: row.collectionName ?? '', tmdbId: row.tmdbCollectionId } }
			: {}),
		popularity: 0,
		lastSearchTime: row.lastSearchTime,
		statistics: {
			movieFileCount: file ? 1 : 0,
			sizeOnDisk: file?.size ?? 0,
			releaseGroups: file?.releaseGroup ? [file.releaseGroup] : []
		}
	};
}

async function loadRootFolderPaths(rootFolderIds: string[]): Promise<Map<string, string>> {
	if (rootFolderIds.length === 0) return new Map();
	const rows = await db
		.select({ id: rootFolders.id, path: rootFolders.path })
		.from(rootFolders)
		.where(inArray(rootFolders.id, rootFolderIds));
	return new Map(rows.map((r) => [r.id, r.path]));
}

export async function buildMovies(): Promise<Record<string, unknown>[]> {
	const rows = await db.select().from(movies).orderBy(desc(movies.added));
	const movieIds = rows.map((r) => r.id);

	const files = movieIds.length
		? await db.select().from(movieFiles).where(inArray(movieFiles.movieId, movieIds))
		: [];
	const fileMap = new Map(files.map((f) => [f.movieId, f]));

	const movieArrIds = await getOrAssignArrIds('movie', movieIds);
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
			movieToResource(
				row,
				fileMap.get(row.id),
				movieArrIds.get(row.id)!,
				row.scoringProfileId ? (profileArrIds.get(row.scoringProfileId) ?? null) : null,
				row.rootFolderId ? (rootFolderPaths.get(row.rootFolderId) ?? null) : null
			)
		)
	);
}

export async function buildMovieByArrId(
	movieArrId: number
): Promise<Record<string, unknown> | null> {
	// Reuses the same list builder rather than a second query path - Cinephage
	// libraries are small enough that this isn't a real cost, and it
	// guarantees the single-item shape never drifts from the list shape.
	const all = await buildMovies();
	return all.find((movie) => movie.id === movieArrId) ?? null;
}

/**
 * `/movie/lookup` - TMDB search for movies not yet in the library. Real
 * Radarr returns sparse MovieResource objects for these (id: 0 - no
 * library entry exists yet - and no path/qualityProfileId/monitored/
 * hasFile, since those only make sense once added).
 *
 * Real Radarr's `term` also accepts `tmdb:<id>` and `imdb:<id>` as a
 * direct-ID lookup instead of a free-text search - arr clients (Seerr's
 * getMovieByTmdbId, used on every add to check for an existing library
 * entry) rely on exactly this syntax, calling `/movie/lookup?term=tmdb:X`
 * rather than the separate `/movie/lookup/tmdb` endpoint. Without this, a
 * client asking "does tmdb:X already exist?" gets an empty array (the
 * literal string "tmdb:X" matches no title) and concludes the id doesn't
 * exist at all - which is exactly what broke real add-to-library requests.
 */
export async function buildMovieLookup(term: string): Promise<Record<string, unknown>[]> {
	const tmdbMatch = /^tmdb:(\d+)$/i.exec(term);
	if (tmdbMatch) {
		const movie = await buildMovieLookupByTmdbId(Number(tmdbMatch[1]));
		return movie ? [movie] : [];
	}

	const imdbMatch = /^imdb:(tt\d+)$/i.exec(term);
	if (imdbMatch) {
		const found = await tmdb.findByExternalId(imdbMatch[1], 'imdb_id');
		const tmdbId = found.movie_results?.[0]?.id;
		if (!tmdbId) return [];
		const movie = await buildMovieLookupByTmdbId(tmdbId);
		return movie ? [movie] : [];
	}

	const result = await tmdb.searchMovies(term);
	return result.results.map((movie) => {
		const year = movie.release_date ? Number.parseInt(movie.release_date.slice(0, 4), 10) : 0;
		return {
			id: 0,
			title: movie.title ?? movie.name ?? '',
			originalTitle: movie.original_title ?? movie.title ?? '',
			sortTitle: cleanTitleFor(movie.title ?? ''),
			status: 'released',
			overview: movie.overview ?? '',
			images: buildMovieImages(movie.poster_path, null),
			remotePoster: tmdbPosterUrl(movie.poster_path),
			year: year || 0,
			tmdbId: movie.id,
			titleSlug: titleSlugFor(movie.id),
			cleanTitle: cleanTitleFor(movie.title ?? ''),
			genres: [],
			ratings: { tmdb: { votes: 0, value: movie.vote_average ?? 0, type: 'user' } },
			monitored: false,
			hasFile: false,
			added: null
		};
	});
}

export async function buildMovieLookupByTmdbId(
	tmdbId: number
): Promise<Record<string, unknown> | null> {
	// Real Radarr's lookup checks the local library first and returns the
	// real entry (real id/monitored/hasFile/rootFolderPath/qualityProfileId)
	// when it already exists, instead of always describing a not-yet-added
	// title - arr clients (Seerr's addMovie) branch on `movie.id` /
	// `movie.monitored` to decide whether to POST (add) or PUT (update) a
	// title, so always returning id: 0 here would make every re-request of
	// an already-added movie look like a brand new add.
	const [existing] = await db
		.select({ id: movies.id })
		.from(movies)
		.where(eq(movies.tmdbId, tmdbId))
		.limit(1);
	if (existing) {
		const arrId = await getOrAssignArrId('movie', existing.id);
		return buildMovieByArrId(arrId);
	}

	try {
		const details = await tmdb.getMovie(tmdbId);
		return {
			id: 0,
			title: details.title,
			originalTitle: details.original_title ?? details.title,
			sortTitle: cleanTitleFor(details.title),
			status: 'released',
			overview: details.overview ?? '',
			images: buildMovieImages(details.poster_path, details.backdrop_path),
			remotePoster: tmdbPosterUrl(details.poster_path),
			year: details.release_date ? Number.parseInt(details.release_date.slice(0, 4), 10) : 0,
			runtime: details.runtime ?? 0,
			tmdbId: details.id,
			imdbId: details.imdb_id ?? null,
			titleSlug: titleSlugFor(details.id),
			cleanTitle: cleanTitleFor(details.title),
			genres: (details.genres ?? []).map((g) => g.name),
			ratings: { tmdb: { votes: 0, value: details.vote_average ?? 0, type: 'user' } },
			monitored: false,
			hasFile: false,
			added: null
		};
	} catch (err) {
		// Real TMDB 404s ("no such movie") are a genuine not-found and should
		// map to the arr-compat 404 the caller already returns for a null
		// result. Anything else (TMDB API key not configured, rate limit,
		// network error) is a real failure that was previously swallowed
		// into the same misleading "Movie not found" - surface it instead so
		// it isn't mistaken for a bad tmdbId.
		const message = err instanceof Error ? err.message : String(err);
		if (/TMDB Error: 404/.test(message)) {
			return null;
		}
		logger.error({ tmdbId, err: message }, '[arr-compat] movie lookup by tmdbId failed');
		throw err;
	}
}

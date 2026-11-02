/**
 * Radarr/Sonarr-compatible add/update/delete for movie and series.
 *
 * "Request" action a Radarr/Sonarr client performs - GET/lookup alone lets a client connect and
 * browse, but POST is what turns a request into something added to the
 * library. Reuses Cinephage's real add/update/delete routes
 * (`/api/library/movies`, `/api/library/series`) via SvelteKit's internal
 * `event.fetch`, the same reuse-over-reimplement pattern release.ts uses
 * for search/grab - so this goes through the exact same validation, TMDB
 * fetch, folder naming, and search-trigger logic the Cinephage UI's own
 * "Add to Library" flow uses, not a parallel reimplementation of it.
 *
 * Field set confirmed against MovieResource/AddMovieOptions and
 * SeriesResource/AddSeriesOptions in Radarr/Sonarr's actual openapi.json.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { rootFolders } from '#lib/server/db/schema.js';
import { getEntityIdForArrId, getOrAssignArrId } from './ArrIdMappingService.js';
import { buildMovieByArrId } from './movies.js';
import { buildSeriesByArrId } from './series.js';
import { tmdb } from '#lib/server/tmdb.js';

type FetchFn = typeof fetch;

interface WriteResult {
	ok: boolean;
	status: number;
	body: unknown;
}

const VALID_MIN_AVAILABILITY = new Set(['announced', 'inCinemas', 'released']);
// Real Sonarr's MonitorTypes enum has more values (unknown, latestSeason,
// monitorSpecials, unmonitorSpecials, skip) than Cinephage's monitorType -
// only forward ones both sides understand, let the real endpoint's own
// default ('all') cover the rest.
const VALID_MONITOR_TYPES = new Set([
	'all',
	'future',
	'missing',
	'existing',
	'firstSeason',
	'lastSeason',
	'recent',
	'pilot',
	'none'
]);
const VALID_SERIES_TYPES = new Set(['standard', 'anime', 'daily']);

async function resolveRootFolderId(rootFolderPath: unknown): Promise<string | undefined> {
	if (typeof rootFolderPath !== 'string' || !rootFolderPath) return undefined;
	const [row] = await db
		.select({ id: rootFolders.id })
		.from(rootFolders)
		.where(eq(rootFolders.path, rootFolderPath))
		.limit(1);
	return row?.id;
}

async function resolveScoringProfileId(qualityProfileArrId: unknown): Promise<string | undefined> {
	if (typeof qualityProfileArrId !== 'number') return undefined;
	return getEntityIdForArrId('qualityProfile', qualityProfileArrId);
}

/** POST /movie - add a movie to the library. */
export async function addMovieFromArr(fetchFn: FetchFn, rawBody: Record<string, unknown>) {
	const tmdbId = rawBody.tmdbId as number | undefined;
	if (!tmdbId) {
		return { ok: false, status: 400, body: { message: 'tmdbId is required' } };
	}

	const rootFolderId = await resolveRootFolderId(rawBody.rootFolderPath);
	if (!rootFolderId) {
		return {
			ok: false,
			status: 400,
			body: { message: `No root folder configured for path: ${rawBody.rootFolderPath}` }
		};
	}

	const scoringProfileId = await resolveScoringProfileId(rawBody.qualityProfileId);
	const addOptions = (rawBody.addOptions ?? {}) as { searchForMovie?: boolean };
	const minimumAvailability = VALID_MIN_AVAILABILITY.has(rawBody.minimumAvailability as string)
		? (rawBody.minimumAvailability as string)
		: undefined;

	const payload: Record<string, unknown> = {
		tmdbId,
		rootFolderId,
		monitored: typeof rawBody.monitored === 'boolean' ? rawBody.monitored : true,
		searchOnAdd: addOptions.searchForMovie ?? false
	};
	if (scoringProfileId) payload.scoringProfileId = scoringProfileId;
	if (minimumAvailability) payload.minimumAvailability = minimumAvailability;

	const response = await fetchFn('/api/library/movies', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	const responseBody = await response.json().catch(() => ({}));
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			body: { message: responseBody.error ?? 'Failed to add movie' }
		};
	}

	const movieId = responseBody.movie?.id as string | undefined;
	if (!movieId) return { ok: true, status: 201, body: responseBody };

	const arrId = await getOrAssignArrId('movie', movieId);
	return { ok: true, status: 201, body: await buildMovieByArrId(arrId) };
}

/** POST /series - add a series to the library. */
export async function addSeriesFromArr(fetchFn: FetchFn, rawBody: Record<string, unknown>) {
	let tmdbId = rawBody.tmdbId as number | undefined;

	// Real Sonarr's identity key for AddSeriesOptions is `tvdbId` (lowercased
	// `tvdbid` in Seerr's actual request body) - it has no tmdbId at all on
	// add, unlike Radarr. Resolve it the same way series.ts's `tvdb:` lookup
	// does, so a client that only ever sends tvdbId (which is every real
	// Sonarr client, Seerr included) doesn't hit a spurious "tmdbId is
	// required" 400.
	if (!tmdbId) {
		const tvdbId = (rawBody.tvdbid ?? rawBody.tvdbId) as number | undefined;
		if (tvdbId) {
			const found = await tmdb.findByExternalId(String(tvdbId), 'tvdb_id');
			tmdbId = found.tv_results?.[0]?.id;
		}
	}

	if (!tmdbId) {
		return { ok: false, status: 400, body: { message: 'tmdbId is required' } };
	}

	const rootFolderId = await resolveRootFolderId(rawBody.rootFolderPath);
	if (!rootFolderId) {
		return {
			ok: false,
			status: 400,
			body: { message: `No root folder configured for path: ${rawBody.rootFolderPath}` }
		};
	}

	const scoringProfileId = await resolveScoringProfileId(rawBody.qualityProfileId);
	const addOptions = (rawBody.addOptions ?? {}) as {
		monitor?: string;
		searchForMissingEpisodes?: boolean;
	};
	const monitorType = VALID_MONITOR_TYPES.has(addOptions.monitor ?? '')
		? addOptions.monitor
		: undefined;
	const seriesType = VALID_SERIES_TYPES.has(rawBody.seriesType as string)
		? (rawBody.seriesType as string)
		: undefined;

	const payload: Record<string, unknown> = {
		tmdbId,
		rootFolderId,
		monitored: typeof rawBody.monitored === 'boolean' ? rawBody.monitored : true,
		seasonFolder: typeof rawBody.seasonFolder === 'boolean' ? rawBody.seasonFolder : true,
		searchOnAdd: addOptions.searchForMissingEpisodes ?? false
	};
	if (scoringProfileId) payload.scoringProfileId = scoringProfileId;
	if (monitorType) payload.monitorType = monitorType;
	if (seriesType) payload.seriesType = seriesType;
	if (rawBody.monitorNewItems === 'none') payload.monitorNewItems = 'none';

	const response = await fetchFn('/api/library/series', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	const responseBody = await response.json().catch(() => ({}));
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			body: { message: responseBody.error ?? 'Failed to add series' }
		};
	}

	const seriesId = responseBody.series?.id as string | undefined;
	if (!seriesId) return { ok: true, status: 201, body: responseBody };

	const arrId = await getOrAssignArrId('series', seriesId);
	return { ok: true, status: 201, body: await buildSeriesByArrId(arrId) };
}

/** PUT /movie/{id} - update monitored state/quality profile/availability. */
export async function updateMovieFromArr(
	fetchFn: FetchFn,
	arrId: number,
	rawBody: Record<string, unknown>
): Promise<WriteResult> {
	const movieId = await getEntityIdForArrId('movie', arrId);
	if (!movieId) return { ok: false, status: 404, body: { message: 'Movie not found' } };

	const payload: Record<string, unknown> = {};
	if (typeof rawBody.monitored === 'boolean') payload.monitored = rawBody.monitored;
	const scoringProfileId = await resolveScoringProfileId(rawBody.qualityProfileId);
	if (scoringProfileId) payload.scoringProfileId = scoringProfileId;
	if (VALID_MIN_AVAILABILITY.has(rawBody.minimumAvailability as string)) {
		payload.minimumAvailability = rawBody.minimumAvailability;
	}

	const response = await fetchFn(`/api/library/movies/${movieId}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	const responseBody = await response.json().catch(() => ({}));
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			body: { message: responseBody.error ?? 'Failed to update movie' }
		};
	}

	return { ok: true, status: 200, body: await buildMovieByArrId(arrId) };
}

/**
 * PUT /series/{id} - update monitored state/quality profile/type.
 *
 * Note: real Seerr's addSeries() also sends a per-season `seasons` array
 * when a series already exists, but doesn't rely on this endpoint to apply
 * it - it separately calls PUT /episode/monitor with the specific episode
 * IDs for the newly-requested seasons (see monitorEpisodesFromArr below),
 * which is the actual mechanism that ends up monitoring them.
 */
export async function updateSeriesFromArr(
	fetchFn: FetchFn,
	arrId: number,
	rawBody: Record<string, unknown>
): Promise<WriteResult> {
	const seriesId = await getEntityIdForArrId('series', arrId);
	if (!seriesId) return { ok: false, status: 404, body: { message: 'Series not found' } };

	const payload: Record<string, unknown> = {};
	if (typeof rawBody.monitored === 'boolean') payload.monitored = rawBody.monitored;
	const scoringProfileId = await resolveScoringProfileId(rawBody.qualityProfileId);
	if (scoringProfileId) payload.scoringProfileId = scoringProfileId;
	if (VALID_SERIES_TYPES.has(rawBody.seriesType as string)) {
		payload.seriesType = rawBody.seriesType;
	}
	if (typeof rawBody.seasonFolder === 'boolean') payload.seasonFolder = rawBody.seasonFolder;

	const response = await fetchFn(`/api/library/series/${seriesId}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	const responseBody = await response.json().catch(() => ({}));
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			body: { message: responseBody.error ?? 'Failed to update series' }
		};
	}

	return { ok: true, status: 200, body: await buildSeriesByArrId(arrId) };
}

/**
 * DELETE /movie/{id} - real Radarr's DELETE always removes the movie from
 * the library entirely; `deleteFiles` only controls whether files on disk
 * are also removed. Always pass removeFromLibrary=true to match that.
 */
export async function deleteMovieFromArr(
	fetchFn: FetchFn,
	arrId: number,
	options: { deleteFiles?: boolean }
): Promise<WriteResult> {
	const movieId = await getEntityIdForArrId('movie', arrId);
	if (!movieId) return { ok: false, status: 404, body: { message: 'Movie not found' } };

	const params = new URLSearchParams({ removeFromLibrary: 'true' });
	if (options.deleteFiles) params.set('deleteFiles', 'true');

	const response = await fetchFn(`/api/library/movies/${movieId}?${params}`, { method: 'DELETE' });
	if (!response.ok) {
		const responseBody = await response.json().catch(() => ({}));
		return {
			ok: false,
			status: response.status,
			body: { message: responseBody.error ?? 'Failed to delete movie' }
		};
	}

	return { ok: true, status: 200, body: {} };
}

/** DELETE /series/{id} - same real semantics as deleteMovieFromArr above. */
export async function deleteSeriesFromArr(
	fetchFn: FetchFn,
	arrId: number,
	options: { deleteFiles?: boolean }
): Promise<WriteResult> {
	const seriesId = await getEntityIdForArrId('series', arrId);
	if (!seriesId) return { ok: false, status: 404, body: { message: 'Series not found' } };

	const params = new URLSearchParams({ removeFromLibrary: 'true' });
	if (options.deleteFiles) params.set('deleteFiles', 'true');

	const response = await fetchFn(`/api/library/series/${seriesId}?${params}`, { method: 'DELETE' });
	if (!response.ok) {
		const responseBody = await response.json().catch(() => ({}));
		return {
			ok: false,
			status: response.status,
			body: { message: responseBody.error ?? 'Failed to delete series' }
		};
	}

	return { ok: true, status: 200, body: {} };
}

/**
 * PUT /episode/monitor - real Sonarr's bulk episode-monitoring endpoint.
 * Seerr calls this right after updating an already-existing series, to
 * re-monitor specific episodes in the newly-requested seasons (the PUT
 * /series call above only carries a season-level `monitored` summary, not
 * per-episode state - this is the actual mechanism Seerr relies on for
 * that, so it isn't a gap after all once this is wired up).
 */
export async function monitorEpisodesFromArr(
	fetchFn: FetchFn,
	episodeArrIds: number[],
	monitored: boolean
): Promise<WriteResult> {
	const episodeIds = (
		await Promise.all(episodeArrIds.map((id) => getEntityIdForArrId('episode', id)))
	).filter((id): id is string => !!id);
	if (episodeIds.length === 0) {
		return { ok: false, status: 404, body: { message: 'No matching episodes found' } };
	}

	const response = await fetchFn('/api/library/episodes/batch', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ episodeIds, monitored })
	});
	const responseBody = await response.json().catch(() => ({}));
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			body: { message: responseBody.error ?? 'Failed to monitor episodes' }
		};
	}

	return { ok: true, status: 200, body: {} };
}

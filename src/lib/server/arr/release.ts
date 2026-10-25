/**
 * Radarr/Sonarr-compatible `release` (interactive search + grab).
 *
 * Reuses Cinephage's real search and grab pipelines - GET calls the existing
 * `/api/search` route (via SvelteKit's internal `event.fetch`, so it goes through real
 * routing without a network round trip) with criteria built from the
 * resolved movie/series, and POST forwards to the existing
 * `/api/download/grab` route. This is the same search/grab logic the
 * Cinephage UI's own Interactive Search modal uses.
 *
 * Field set confirmed against ReleaseResource in Radarr/Sonarr's actual
 * openapi.json.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { movies, series, episodes } from '#lib/server/db/schema.js';
import { getEntityIdForArrId, getOrAssignArrId } from './ArrIdMappingService.js';
import type { ArrAppName } from './systemStatus.js';

type FetchFn = typeof fetch;

interface RawRelease {
	guid: string;
	title: string;
	downloadUrl: string;
	commentsUrl?: string;
	publishDate: string;
	size: number;
	indexerId: string;
	indexerName: string;
	protocol: 'torrent' | 'usenet' | 'streaming';
	torrent?: { seeders: number; leechers: number; infoHash?: string; magnetUrl?: string };
}

const PROTOCOL_MAP: Record<string, string> = {
	torrent: 'torrent',
	usenet: 'usenet',
	streaming: 'unknown'
};

async function releaseToResource(
	release: RawRelease,
	appName: ArrAppName,
	mappedId: number
): Promise<Record<string, unknown>> {
	const publishDate = new Date(release.publishDate);
	const ageMs = Date.now() - publishDate.getTime();
	const ageHours = ageMs / (1000 * 60 * 60);

	const base: Record<string, unknown> = {
		id: await getOrAssignArrId('release', `${release.indexerId}:${release.guid}`),
		guid: release.guid,
		quality: {
			quality: { id: 1, name: 'Unknown', resolution: 0 },
			revision: { version: 1, real: 0, isRepack: false }
		},
		customFormats: [],
		customFormatScore: 0,
		qualityWeight: 0,
		age: Math.floor(ageHours / 24),
		ageHours,
		ageMinutes: ageMs / (1000 * 60),
		size: release.size,
		indexerId: 0,
		indexer: release.indexerName,
		title: release.title,
		languages: [],
		approved: true,
		temporarilyRejected: false,
		rejected: false,
		rejections: [],
		publishDate: release.publishDate,
		commentUrl: release.commentsUrl ?? null,
		downloadUrl: release.downloadUrl,
		downloadAllowed: true,
		releaseWeight: 0,
		magnetUrl: release.torrent?.magnetUrl ?? null,
		infoHash: release.torrent?.infoHash ?? null,
		seeders: release.torrent?.seeders ?? null,
		leechers: release.torrent?.leechers ?? null,
		protocol: PROTOCOL_MAP[release.protocol] ?? 'unknown'
	};

	if (appName === 'Radarr') {
		base.movieId = mappedId;
		base.mappedMovieId = mappedId;
	} else {
		base.seriesId = mappedId;
	}

	return base;
}

export async function searchReleasesForMovie(
	fetchFn: FetchFn,
	movieArrId: number
): Promise<Record<string, unknown>[]> {
	const movieId = await getEntityIdForArrId('movie', movieArrId);
	if (!movieId) return [];

	const movie = await db.select().from(movies).where(eq(movies.id, movieId)).get();
	if (!movie) return [];

	const params = new URLSearchParams({
		q: movie.title,
		searchType: 'movie',
		enrich: 'true',
		filterRejected: 'false',
		tmdbId: String(movie.tmdbId)
	});
	if (movie.year) params.set('year', String(movie.year));
	if (movie.imdbId) params.set('imdbId', movie.imdbId);
	if (movie.scoringProfileId) params.set('scoringProfileId', movie.scoringProfileId);

	const response = await fetchFn(`/api/search?${params}`);
	if (!response.ok) return [];
	const data = (await response.json()) as { releases?: RawRelease[] };

	return Promise.all(
		(data.releases ?? []).map((release) => releaseToResource(release, 'Radarr', movieArrId))
	);
}

export async function searchReleasesForSeries(
	fetchFn: FetchFn,
	seriesArrId: number,
	options: { episodeArrId?: number; seasonNumber?: number }
): Promise<Record<string, unknown>[]> {
	const seriesId = await getEntityIdForArrId('series', seriesArrId);
	if (!seriesId) return [];

	const show = await db.select().from(series).where(eq(series.id, seriesId)).get();
	if (!show) return [];

	let seasonNumber = options.seasonNumber;
	let episodeNumber: number | undefined;
	if (options.episodeArrId !== undefined) {
		const episodeId = await getEntityIdForArrId('episode', options.episodeArrId);
		if (episodeId) {
			const episode = await db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
			if (episode) {
				seasonNumber = episode.seasonNumber;
				episodeNumber = episode.episodeNumber;
			}
		}
	}

	const params = new URLSearchParams({
		q: show.title,
		searchType: 'tv',
		enrich: 'true',
		filterRejected: 'false',
		tmdbId: String(show.tmdbId)
	});
	if (show.year) params.set('year', String(show.year));
	if (show.imdbId) params.set('imdbId', show.imdbId);
	if (show.scoringProfileId) params.set('scoringProfileId', show.scoringProfileId);
	if (seasonNumber !== undefined) params.set('season', String(seasonNumber));
	if (episodeNumber !== undefined) params.set('episode', String(episodeNumber));

	const response = await fetchFn(`/api/search?${params}`);
	if (!response.ok) return [];
	const data = (await response.json()) as { releases?: RawRelease[] };

	return Promise.all(
		(data.releases ?? []).map((release) => releaseToResource(release, 'Sonarr', seriesArrId))
	);
}

/**
 * POST /release - grab a specific release, forwarding to the existing
 * /api/download/grab route rather than reimplementing grab logic.
 */
export async function grabRelease(
	fetchFn: FetchFn,
	appName: ArrAppName,
	body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const mappedArrId = (appName === 'Radarr' ? body.movieId : body.seriesId) as number | undefined;
	if (mappedArrId === undefined) {
		return { ok: false, status: 400, body: { error: 'movieId/seriesId is required' } };
	}

	const entityId = await getEntityIdForArrId(
		appName === 'Radarr' ? 'movie' : 'series',
		mappedArrId
	);
	if (!entityId) {
		return { ok: false, status: 404, body: { error: 'Movie/series not found' } };
	}

	const grabBody: Record<string, unknown> = {
		guid: body.guid,
		downloadUrl: body.downloadUrl,
		magnetUrl: body.magnetUrl,
		infoHash: body.infoHash,
		title: body.title,
		protocol: body.protocol === 'unknown' ? 'torrent' : body.protocol,
		size: body.size,
		publishDate: body.publishDate,
		commentsUrl: body.commentUrl,
		mediaType: appName === 'Radarr' ? 'movie' : 'tv',
		isAutomatic: false
	};
	if (appName === 'Radarr') {
		grabBody.movieId = entityId;
	} else {
		grabBody.seriesId = entityId;
		// Preserve Sonarr scope. Dropping episode/season widened the grab to
		// the whole series (empty episodeIds backfills every missing episode
		// in GrabService.resolveTarget).
		if (typeof body.seasonNumber === 'number') {
			grabBody.seasonNumber = body.seasonNumber;
		}
		if (typeof body.episodeId === 'number') {
			const episodeEntityId = await getEntityIdForArrId('episode', body.episodeId);
			if (!episodeEntityId) {
				return { ok: false, status: 404, body: { error: 'Episode not found' } };
			}
			grabBody.episodeIds = [episodeEntityId];
		}
	}

	const response = await fetchFn('/api/download/grab', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(grabBody)
	});
	const responseBody = await response.json().catch(() => ({}));
	return { ok: response.ok, status: response.status, body: responseBody };
}

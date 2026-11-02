/**
 * GET /api/requests/media-status?mediaType=&tmdbId=
 *
 * Pre-submit state for the request modal: the scopes held by active
 * requests for this title (any requester — duplicates are cross-user, so
 * the modal must lock those rows) and which episodes already have files.
 * Aggregate scope data only; no usernames or request ids cross the wire.
 */

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { episodes, movies, requests, series } from '#lib/server/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { ACTIVE_REQUEST_STATUSES } from '#lib/server/requests/types.js';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const mediaType = event.url.searchParams.get('mediaType');
	const tmdbIdParam = Number(event.url.searchParams.get('tmdbId'));
	if (
		(mediaType !== 'movie' && mediaType !== 'series') ||
		!Number.isInteger(tmdbIdParam) ||
		tmdbIdParam <= 0
	) {
		return Response.json({ success: false, error: 'Invalid mediaType or tmdbId' }, { status: 400 });
	}

	const activeRows = await db
		.select({ seasons: requests.seasons, episodes: requests.episodes })
		.from(requests)
		.where(
			and(
				eq(requests.mediaType, mediaType),
				eq(requests.tmdbId, tmdbIdParam),
				inArray(requests.status, [...ACTIVE_REQUEST_STATUSES])
			)
		);

	if (mediaType === 'movie') {
		const [movie] = await db
			.select({ hasFile: movies.hasFile, monitored: movies.monitored })
			.from(movies)
			.where(eq(movies.tmdbId, tmdbIdParam))
			.limit(1);
		return Response.json({
			success: true,
			mediaType,
			tmdbId: tmdbIdParam,
			active: activeRows.length > 0,
			inLibrary: !!movie,
			hasFile: movie?.hasFile ?? false,
			monitored: movie?.monitored ?? false,
			availableEpisodes: [] as string[]
		});
	}

	const [existingSeries] = await db
		.select({ id: series.id })
		.from(series)
		.where(eq(series.tmdbId, tmdbIdParam))
		.limit(1);

	let availableEpisodes: string[] = [];
	if (existingSeries) {
		const rows = await db
			.select({ seasonNumber: episodes.seasonNumber, episodeNumber: episodes.episodeNumber })
			.from(episodes)
			.where(and(eq(episodes.seriesId, existingSeries.id), eq(episodes.hasFile, true)));
		availableEpisodes = rows.map((r) => `${r.seasonNumber}x${r.episodeNumber}`);
	}

	return Response.json({
		success: true,
		mediaType,
		tmdbId: tmdbIdParam,
		activeScopes: activeRows.map((r) => ({
			seasons: r.seasons ?? [],
			episodes: r.episodes ?? []
		})),
		inLibrary: !!existingSeries,
		availableEpisodes
	});
};

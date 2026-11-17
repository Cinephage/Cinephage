/**
 * App-event publishers — the only place that knows both a domain object and
 * the notification payload shape.
 *
 * Call sites stay one line (`void publishGrab(...)`), because resolving the
 * movie/series title, formatting quality and mapping request events is work
 * that belongs next to the event vocabulary, not in the importer.
 */

import { inArray, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { episodes, movies, requests, series, user } from '#lib/server/db/schema.js';
import type { RequestNotificationEvent } from '#lib/server/requests/RequestNotificationService.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getNotificationDeliveryService } from './delivery.js';
import { buildLink, libraryPath, tmdbPosterUrl } from './links.js';
import type { NotificationEvent, NotificationEpisodeRef, NotificationMediaRef } from './events.js';

const logger = createChildLogger({ module: 'NotificationEvents', logDomain: 'system' });

interface QualityLike {
	resolution?: string | null;
	source?: string | null;
	modifier?: string | null;
	releaseGroup?: string | null;
}

export function formatQuality(quality: QualityLike | null | undefined): string | null {
	if (!quality) return null;
	const parts = [quality.resolution, quality.source, quality.modifier].filter(
		(part): part is string => Boolean(part)
	);
	return parts.length > 0 ? parts.join(' ') : null;
}

function swallow(event: NotificationEvent, run: Promise<void>): void {
	void run.catch((error) => {
		logger.warn(
			{ event, error: error instanceof Error ? error.message : String(error) },
			'[Notifications] Failed to publish event'
		);
	});
}

async function movieRef(movieId: string): Promise<NotificationMediaRef | null> {
	const [row] = await db
		.select({
			title: movies.title,
			year: movies.year,
			tmdbId: movies.tmdbId,
			posterPath: movies.posterPath
		})
		.from(movies)
		.where(eq(movies.id, movieId))
		.limit(1);
	return row
		? {
				type: 'movie',
				title: row.title,
				year: row.year,
				tmdbId: row.tmdbId,
				posterUrl: tmdbPosterUrl(row.posterPath)
			}
		: null;
}

async function seriesRef(seriesId: string): Promise<NotificationMediaRef | null> {
	const [row] = await db
		.select({
			title: series.title,
			year: series.year,
			tmdbId: series.tmdbId,
			tvdbId: series.tvdbId,
			posterPath: series.posterPath
		})
		.from(series)
		.where(eq(series.id, seriesId))
		.limit(1);
	return row
		? {
				type: 'series',
				title: row.title,
				year: row.year,
				tmdbId: row.tmdbId,
				tvdbId: row.tvdbId,
				posterUrl: tmdbPosterUrl(row.posterPath)
			}
		: null;
}

async function episodeRefs(episodeIds: string[] | undefined): Promise<NotificationEpisodeRef[]> {
	if (!episodeIds || episodeIds.length === 0) return [];
	const rows = await db
		.select({
			seasonNumber: episodes.seasonNumber,
			episodeNumber: episodes.episodeNumber,
			title: episodes.title
		})
		.from(episodes)
		.where(inArray(episodes.id, episodeIds))
		.orderBy(episodes.seasonNumber, episodes.episodeNumber);
	return rows.map((row) => ({
		seasonNumber: row.seasonNumber,
		episodeNumber: row.episodeNumber,
		title: row.title
	}));
}

/** A release was accepted and handed to a download client. */
export function publishGrab(params: {
	releaseName: string;
	movieId?: string | null;
	seriesId?: string | null;
	episodeIds?: string[];
	seasonNumber?: number | null;
	quality?: QualityLike | null;
	indexerName?: string | null;
	isUpgrade?: boolean;
}): void {
	swallow(
		'grab',
		(async () => {
			const media = params.movieId
				? await movieRef(params.movieId)
				: params.seriesId
					? await seriesRef(params.seriesId)
					: null;
			const refs = await episodeRefs(params.episodeIds);
			const episodeRefsFinal =
				refs.length === 0 && params.seasonNumber != null
					? [{ seasonNumber: params.seasonNumber, episodeNumber: 0 }]
					: refs;
			await getNotificationDeliveryService().publish('grab', {
				event: 'grab',
				media: media ?? undefined,
				episodes: episodeRefsFinal.length > 0 ? episodeRefsFinal : undefined,
				releaseName: params.releaseName,
				quality: formatQuality(params.quality),
				indexer: params.indexerName ?? null,
				link: media
					? await buildLink(libraryPath(media.type, (params.movieId ?? params.seriesId) as string))
					: null,
				summary: params.isUpgrade
					? 'Upgrade release sent to the download client'
					: 'Release sent to the download client'
			});
		})()
	);
}

/** A file landed in the library, replacing an existing one on upgrade. */
export function publishImport(params: {
	mediaType: 'movie' | 'series';
	mediaId: string;
	episodeIds?: string[];
	releaseName?: string | null;
	quality?: QualityLike | null;
	wasUpgrade?: boolean;
}): void {
	swallow(
		params.wasUpgrade ? 'upgrade' : 'import',
		(async () => {
			const media =
				params.mediaType === 'movie'
					? await movieRef(params.mediaId)
					: await seriesRef(params.mediaId);
			const refs = await episodeRefs(params.episodeIds);
			const event: NotificationEvent = params.wasUpgrade ? 'upgrade' : 'import';
			await getNotificationDeliveryService().publish(event, {
				event,
				media: media ?? undefined,
				episodes: refs.length > 0 ? refs : undefined,
				releaseName: params.releaseName ?? null,
				quality: formatQuality(params.quality),
				link: media ? await buildLink(libraryPath(params.mediaType, params.mediaId)) : null,
				summary:
					params.mediaType === 'movie'
						? params.wasUpgrade
							? 'Movie upgraded in the library'
							: 'Movie imported into the library'
						: params.wasUpgrade
							? 'Episodes upgraded in the library'
							: 'Episodes imported into the library'
			});
		})()
	);
}

/** Mapping from the in-app request feed's vocabulary to external events. */
const REQUEST_EVENT_MAP: Record<RequestNotificationEvent, NotificationEvent> = {
	request_pending: 'request_pending',
	request_approved_auto: 'request_approved',
	request_approved: 'request_approved',
	request_declined: 'request_declined',
	request_expired: 'request_expired',
	request_failed: 'request_failed',
	request_fulfilled: 'request_available'
};

const REQUEST_SUMMARY: Record<RequestNotificationEvent, string> = {
	request_pending: 'A new media request is waiting for approval',
	request_approved_auto: 'A media request was approved automatically',
	request_approved: 'A media request was approved',
	request_declined: 'A media request was declined',
	request_expired: 'A media request expired without a decision',
	request_failed: 'A media request failed',
	request_fulfilled: 'Requested media is now available'
};

interface RequestContext {
	requestedBy: string | null;
	tmdbId: number | null;
	mediaType: 'movie' | 'series' | null;
	posterUrl: string | null;
}

/**
 * One lookup gives the external payload what the in-app feed row already
 * carries: who asked, and which title (some request events omit the TMDB id).
 */
async function requestContext(requestId: string | undefined): Promise<RequestContext> {
	if (!requestId) return { requestedBy: null, tmdbId: null, mediaType: null, posterUrl: null };
	const [row] = await db
		.select({
			name: user.name,
			username: user.displayUsername,
			tmdbId: requests.tmdbId,
			mediaType: requests.mediaType,
			posterPath: requests.posterPath
		})
		.from(requests)
		.innerJoin(user, eq(requests.requestedBy, user.id))
		.where(eq(requests.id, requestId))
		.limit(1);
	if (!row) return { requestedBy: null, tmdbId: null, mediaType: null, posterUrl: null };
	return {
		requestedBy: row.name ?? row.username ?? null,
		tmdbId: row.tmdbId,
		mediaType: row.mediaType === 'series' ? 'series' : 'movie',
		posterUrl: tmdbPosterUrl(row.posterPath)
	};
}

/**
 * Mirrors one in-app request notification to external agents. Called from
 * RequestNotificationService alongside the durable feed row, so the two can
 * never drift: same event, same moment, same recipients rule.
 */
export function publishRequestEvent(
	event: RequestNotificationEvent,
	payload: Record<string, unknown>,
	requestId?: string
): void {
	const externalEvent = REQUEST_EVENT_MAP[event];
	swallow(
		externalEvent,
		(async () => {
			const title = typeof payload.title === 'string' ? payload.title : null;
			const mediaType = payload.mediaType === 'series' ? 'series' : 'movie';
			const reason = typeof payload.reason === 'string' ? payload.reason : null;
			const context = await requestContext(requestId);
			const tmdbId =
				typeof payload.tmdbId === 'number'
					? payload.tmdbId
					: context.mediaType === mediaType
						? context.tmdbId
						: null;
			await getNotificationDeliveryService().publish(externalEvent, {
				event: externalEvent,
				media: title ? { type: mediaType, title, tmdbId, posterUrl: context.posterUrl } : undefined,
				request: requestId
					? {
							id: requestId,
							requestedBy: context.requestedBy,
							status: typeof payload.status === 'string' ? payload.status : null,
							reason
						}
					: undefined,
				link: await buildLink('/requests'),
				summary: REQUEST_SUMMARY[event]
			});
		})()
	);
}

/**
 * A scheduled task threw. This is the *arr-style "something needs you" event:
 * a failed missing-search, indexer refresh or maintenance run otherwise only
 * shows up in Monitoring → Tasks, where nobody is looking.
 */
export function publishTaskFailed(params: {
	taskId: string;
	taskName: string;
	error: string;
}): void {
	swallow(
		'task_failed',
		(async () => {
			await getNotificationDeliveryService().publish('task_failed', {
				event: 'task_failed',
				task: { name: params.taskName, error: params.error },
				link: await buildLink('/settings/monitoring/tasks'),
				summary: `${params.taskName} failed`
			});
		})()
	);
}

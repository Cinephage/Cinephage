import { db } from '#lib/server/db/index.js';
import { movies, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { getRequestService } from './RequestService.js';
import { getRequestNotificationService } from './RequestNotificationService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'RequestProjector', logDomain: 'system' });

/**
 * Projects library changes onto active requests: when media matching a
 * request's TMDB identity appears or gains files, the request advances to
 * fulfilled (pending requests skip approval entirely — the media exists).
 *
 * Events rarely carry tmdbId yet, so movie/series ids are resolved through
 * a DB lookup; the periodic sweep covers event-less paths (manual import,
 * unmatched matching) and anything missed while listeners were down.
 */
export class RequestAvailabilityProjector {
	private started = false;
	private listeners: Array<() => void> = [];

	start(): void {
		if (this.started) return;
		this.started = true;

		const onDataChanged = (event: {
			source: string;
			reason: string;
			entityId?: string;
			tmdbId?: number;
		}) => {
			void this.handleDataChanged(event).catch((err) => {
				logger.warn(
					{ reason: event.reason, error: err instanceof Error ? err.message : String(err) },
					'[RequestProjector] Failed to process library:data-changed'
				);
			});
		};

		libraryMediaEvents.on('library:data-changed', onDataChanged);
		this.listeners.push(() => libraryMediaEvents.off('library:data-changed', onDataChanged));
	}

	stop(): void {
		for (const off of this.listeners) off();
		this.listeners = [];
		this.started = false;
	}

	private async handleDataChanged(event: {
		source: string;
		reason: string;
		entityId?: string;
		tmdbId?: number;
	}): Promise<void> {
		if (event.source === 'root-folder' || event.source === 'library') {
			await getRequestService().retryAwaitingTarget();
			return;
		}

		let tmdbId = event.tmdbId ?? null;
		let mediaType: 'movie' | 'series' | null =
			event.source === 'movie' ? 'movie' : event.source === 'series' ? 'series' : null;

		if ((!tmdbId || !mediaType) && event.entityId) {
			const resolved = await this.resolveTmdbId(event.entityId, event.source);
			if (resolved) {
				tmdbId = tmdbId ?? resolved.tmdbId;
				mediaType = mediaType ?? resolved.mediaType;
			}
		}

		if (tmdbId && mediaType) {
			await getRequestService().advanceFulfilledByMedia(mediaType, tmdbId);
		}
	}

	private async resolveTmdbId(
		entityId: string,
		source: string
	): Promise<{ tmdbId: number; mediaType: 'movie' | 'series' } | null> {
		if (source === 'series' || source === 'season' || source === 'episode') {
			const [row] = await db
				.select({ tmdbId: series.tmdbId })
				.from(series)
				.where(eq(series.id, entityId))
				.limit(1);
			if (row) return { tmdbId: row.tmdbId, mediaType: 'series' };
		}
		if (source === 'movie') {
			const [row] = await db
				.select({ tmdbId: movies.tmdbId })
				.from(movies)
				.where(eq(movies.id, entityId))
				.limit(1);
			if (row) return { tmdbId: row.tmdbId, mediaType: 'movie' };
		}
		return null;
	}

	/**
	 * Periodic sweep: re-evaluates every active request (covers event-less
	 * mutation paths) and expires stale pending requests. Called from the
	 * monitoring scheduler cadence.
	 */
	async runSweep(): Promise<{
		fulfilledAdvanced: number;
		expired: number;
		targetRetries: number;
		orphanedFailed: number;
		notificationsPruned: number;
	}> {
		const requestService = getRequestService();
		const expired = await requestService.expireStalePending();
		const targetRetries = await requestService.retryAwaitingTarget();
		const orphanedFailed = await requestService.reconcileDeletedMedia();
		const notificationsPruned = await getRequestNotificationService().pruneReadNotifications(30);

		// Identity-keyed, not row-limited: every active request's media gets
		// re-evaluated no matter how many rows share the newest-100 window.
		const keys = await requestService.listActiveMediaKeys();
		let fulfilledAdvanced = 0;
		for (const key of keys) {
			fulfilledAdvanced += await requestService.advanceFulfilledByMedia(key.mediaType, key.tmdbId);
		}
		return { fulfilledAdvanced, expired, targetRetries, orphanedFailed, notificationsPruned };
	}
}

let _instance: RequestAvailabilityProjector | null = null;

export function getRequestAvailabilityProjector(): RequestAvailabilityProjector {
	if (!_instance) {
		_instance = new RequestAvailabilityProjector();
	}
	return _instance;
}

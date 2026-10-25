import { db } from '#lib/server/db/index.js';
import {
	requests,
	movies,
	series,
	seasons,
	episodes,
	movieFiles,
	rootFolders
} from '#lib/server/db/schema.js';
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
	fetchMovieDetails,
	fetchSeriesDetails,
	triggerMovieSearch,
	triggerSeriesSearch
} from '#lib/server/library/LibraryAddService.js';
import { addMovieToLibrary } from '#lib/server/library/add/add-movie.js';
import { addSeriesToLibrary } from '#lib/server/library/add/add-series.js';
import { blockedMediaService } from '#lib/server/blocked-media/service.js';
import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
import { getRequestSettingsService } from './RequestSettingsService.js';
import { getUserRequestSettingsService } from './UserRequestSettingsService.js';
import { getRequestNotificationService } from './RequestNotificationService.js';
import { requestStreamEvents } from './RequestStreamEvents.js';
import {
	ACTIVE_REQUEST_STATUSES,
	QUOTA_EXCLUDED_STATUSES,
	TERMINAL_REQUEST_STATUSES,
	RequestError,
	type QuotaStatus,
	type RequestEpisodeEntry,
	type RequesterContext,
	type RequestStatus
} from './types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'RequestService', logDomain: 'system' });

export interface CreateRequestInput {
	mediaType: 'movie' | 'series';
	tmdbId: number;
	seasons?: number[];
	episodes?: RequestEpisodeEntry[];
}

interface TmdbSnapshot {
	title: string;
	posterPath: string | null;
	year: number | null;
	/** TMDB season -> episode count, for TV quota estimation at create time. */
	seasonEpisodeCounts: Map<number, number>;
	isAnime: boolean;
}

/**
 * The request workflow authority. Creation/duplicate/quota/cooldown rules
 * live here; approval drives the shared library-add orchestrators
 * (addMovieToLibrary / addSeriesToLibrary) and never touches the download
 * queue or acquisition services directly — searchOnAdd and the monitoring
 * tasks own acquisition end-to-end.
 */
export class RequestService {
	/** Per-user promise chain: serializes creations against double-clicks. */
	private createChains = new Map<string, Promise<unknown>>();

	private async serialized<T>(userId: string, fn: () => Promise<T>): Promise<T> {
		const prior = this.createChains.get(userId) ?? Promise.resolve();
		const next = prior.then(fn, fn);
		this.createChains.set(
			userId,
			next.catch(() => undefined)
		);
		return next;
	}

	// ---------------------------------------------------------------------------
	// Quota
	// ---------------------------------------------------------------------------

	async getQuota(
		requesterId: string,
		role: 'admin' | 'user'
	): Promise<{
		movie: QuotaStatus;
		tv: QuotaStatus;
	}> {
		const settings = await getRequestSettingsService().getRequestSettings();
		const overrides = await getUserRequestSettingsService().getUserRequestSettings(requesterId);

		const compute = async (
			mediaType: 'movie' | 'series',
			userLimit: number | null,
			userDays: number | null
		): Promise<QuotaStatus> => {
			if (role === 'admin') {
				return { days: null, limit: null, used: 0, remaining: null, restricted: false };
			}
			const global = settings.defaultQuotas[mediaType === 'movie' ? 'movie' : 'tv'];
			const limit = userLimit ?? global.limit ?? null;
			const days = userDays ?? global.days ?? null;
			const unlimited = limit === null || limit === 0;

			const windowStart = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
			const conditions = [eq(requests.requestedBy, requesterId), eq(requests.mediaType, mediaType)];
			if (windowStart) {
				conditions.push(gt(requests.createdAt, windowStart));
			}

			const rows = await db
				.select({
					status: requests.status,
					seasons: requests.seasons,
					episodes: requests.episodes,
					episodeCountSnapshot: requests.episodeCountSnapshot
				})
				.from(requests)
				.where(and(...conditions));

			let used = 0;
			for (const row of rows) {
				if ((QUOTA_EXCLUDED_STATUSES as readonly string[]).includes(row.status)) continue;
				if (mediaType === 'movie') {
					used += 1;
					continue;
				}
				used += this.countTvUnits(
					row.seasons ?? [],
					row.episodes ?? [],
					row.episodeCountSnapshot ?? [],
					settings.tvQuotaUnit
				);
			}

			if (unlimited) {
				return { days, limit: null, used, remaining: null, restricted: false };
			}
			const remaining = Math.max(0, limit - used);
			return { days, limit, used, remaining, restricted: remaining <= 0 };
		};

		return {
			movie: await compute('movie', overrides.movieQuotaLimit, overrides.movieQuotaDays),
			tv: await compute('series', overrides.tvQuotaLimit, overrides.tvQuotaDays)
		};
	}

	/**
	 * TV quota units for one request. Unit 'episodes' (default): episode
	 * entries count one each, whole-season entries count their (snapshotted)
	 * episode totals. Unit 'seasons': distinct season numbers touched.
	 */
	private countTvUnits(
		seasons: number[],
		episodes: RequestEpisodeEntry[],
		snapshot: { season: number; count: number }[],
		unit: 'episodes' | 'seasons'
	): number {
		if (unit === 'seasons') {
			return new Set([...seasons, ...episodes.map((e) => e.seasonNumber)]).size;
		}
		const snapshotBySeason = new Map(snapshot.map((s) => [s.season, s.count]));
		return episodes.length + seasons.reduce((sum, s) => sum + (snapshotBySeason.get(s) ?? 0), 0);
	}

	/**
	 * The effective auto-approve decision source for a user + media type:
	 * admins always, per-user override next, else the global setting. Used
	 * by create and surfaced through the count endpoint for modal banners.
	 */
	async getEffectiveAutoApprove(
		requesterId: string,
		role: 'admin' | 'user',
		mediaType: 'movie' | 'series'
	): Promise<boolean> {
		if (role === 'admin') return true;
		const settings = await getRequestSettingsService().getRequestSettings();
		const overrides = await getUserRequestSettingsService().getUserRequestSettings(requesterId);
		return (
			overrides.autoApprove ??
			(mediaType === 'movie' ? settings.autoApprove.movie : settings.autoApprove.series)
		);
	}

	// ---------------------------------------------------------------------------
	// Create
	// ---------------------------------------------------------------------------

	async create(requester: RequesterContext, input: CreateRequestInput) {
		return this.serialized(requester.id, () => this.createUnlocked(requester, input));
	}

	private async createUnlocked(requester: RequesterContext, input: CreateRequestInput) {
		const settings = await getRequestSettingsService().getRequestSettings();

		if (!settings.requestsEnabled) {
			throw new RequestError('requests_disabled', 'Requests are currently disabled', 403);
		}

		if (requester.role !== 'admin') {
			const userSettings = await getUserRequestSettingsService().getUserRequestSettings(
				requester.id
			);
			if (userSettings.requestsDisabled) {
				throw new RequestError(
					'requesting_disabled',
					'Requesting is disabled for this account',
					403
				);
			}
		}

		if (requester.banned) {
			throw new RequestError('banned', 'This account is banned', 403);
		}

		if (
			await blockedMediaService.isBlocked(
				input.tmdbId,
				input.mediaType === 'movie' ? 'movie' : 'tv'
			)
		) {
			throw new RequestError('blocked_media', 'This media is blocked', 403);
		}

		// --- Scope normalization ---
		const scope = this.normalizeScope(input);
		if (input.mediaType === 'movie' && (scope.seasons.length > 0 || scope.episodes.length > 0)) {
			throw new RequestError('invalid_scope', 'Seasons/episodes are not valid for movies', 400);
		}

		// --- TMDB snapshot ---
		const snapshot = await this.fetchSnapshot(input.mediaType, input.tmdbId);
		if (input.mediaType === 'series') {
			this.validateScopeAgainstSnapshot(scope, snapshot);
		}

		// --- Cooldown: last declined/expired request for this media (any requester) ---
		if (settings.reRequestCooldownDays > 0) {
			const cutoff = new Date(
				Date.now() - settings.reRequestCooldownDays * 86_400_000
			).toISOString();
			const recentDecline = await db
				.select({ id: requests.id })
				.from(requests)
				.where(
					and(
						eq(requests.mediaType, input.mediaType),
						eq(requests.tmdbId, input.tmdbId),
						inArray(requests.status, ['declined', 'expired']),
						gt(requests.decidedAt, cutoff)
					)
				)
				.limit(1);
			if (recentDecline.length > 0) {
				throw new RequestError(
					'cooldown',
					`This media was recently declined; re-requesting is blocked for ${settings.reRequestCooldownDays} days`,
					403,
					{ cooldownDays: settings.reRequestCooldownDays }
				);
			}
		}

		// --- In-library rules + duplicate scope ---
		const effectiveScope = await this.computeEffectiveScope(input.mediaType, input.tmdbId, scope);

		const activeRequests = await db
			.select({ seasons: requests.seasons, episodes: requests.episodes })
			.from(requests)
			.where(
				and(
					eq(requests.mediaType, input.mediaType),
					eq(requests.tmdbId, input.tmdbId),
					inArray(requests.status, [...ACTIVE_REQUEST_STATUSES])
				)
			);
		if (input.mediaType === 'movie' && activeRequests.length > 0) {
			throw new RequestError('duplicate_request', 'An active request already exists', 409);
		}
		if (input.mediaType === 'series') {
			const overlap = this.findScopeOverlap(
				{ seasons: effectiveScope.seasons, episodes: effectiveScope.episodes },
				activeRequests.map((r) => ({
					seasons: r.seasons ?? [],
					episodes: r.episodes ?? []
				}))
			);
			if (overlap) {
				throw new RequestError(
					'duplicate_request',
					'An active request already covers part of this selection',
					409,
					overlap
				);
			}
		}

		// --- Quota ---
		if (requester.role !== 'admin') {
			const quota = await this.getQuota(requester.id, requester.role);
			if (input.mediaType === 'movie') {
				if (quota.movie.restricted) {
					throw new RequestError('movie_quota', 'Movie request quota exceeded', 403, {
						quota: quota.movie
					});
				}
			} else {
				// Seasons unit counts distinct seasons touched, including those
				// only reached through episode picks — the same definition
				// countTvUnits uses for `used`, so enforcement and accounting
				// cannot diverge.
				const needed =
					settings.tvQuotaUnit === 'seasons'
						? new Set([
								...effectiveScope.seasons,
								...effectiveScope.episodes.map((e) => e.seasonNumber)
							]).size
						: effectiveScope.episodes.length +
							effectiveScope.seasons.reduce(
								(sum, s) => sum + (snapshot.seasonEpisodeCounts.get(s) ?? 0),
								0
							);
				if (quota.tv.remaining !== null && needed > quota.tv.remaining) {
					throw new RequestError('tv_quota', 'TV request quota exceeded', 403, {
						quota: quota.tv,
						needed
					});
				}
			}
		}

		const now = new Date().toISOString();
		const expiresAt =
			settings.pendingTtlDays > 0
				? new Date(Date.now() + settings.pendingTtlDays * 86_400_000).toISOString()
				: null;

		const [created] = await db
			.insert(requests)
			.values({
				mediaType: input.mediaType,
				tmdbId: input.tmdbId,
				title: snapshot.title,
				posterPath: snapshot.posterPath,
				year: snapshot.year,
				status: 'pending',
				seasons: input.mediaType === 'series' ? effectiveScope.seasons : null,
				episodes: input.mediaType === 'series' ? effectiveScope.episodes : null,
				// Snapshot at create: pending whole-season requests must debit
				// TV quota in episode units immediately (approval later refines
				// the counts from the actual episode rows).
				episodeCountSnapshot:
					input.mediaType === 'series'
						? effectiveScope.seasons.map((s) => ({
								season: s,
								count: snapshot.seasonEpisodeCounts.get(s) ?? 0
							}))
						: null,
				requestedBy: requester.id,
				actingUserId: requester.actingUserId ?? null,
				expiresAt
			})
			.returning();

		requestStreamEvents.emitRefresh({
			requesterId: requester.id,
			requestId: created.id,
			timestamp: now
		});

		// --- Auto-approve ---
		const autoApprove = await this.getEffectiveAutoApprove(
			requester.id,
			requester.role,
			input.mediaType
		);

		if (autoApprove) {
			try {
				return await this.approveInternal(created.id, requester, true);
			} catch (error) {
				// Approval failures leave a durable failed request, never a throw
				// out of create — the request itself was accepted.
				logger.warn(
					{ requestId: created.id, error: error instanceof Error ? error.message : String(error) },
					'[Requests] Auto-approval failed; request left failed'
				);
				return this.getRequest(created.id);
			}
		}

		await getRequestNotificationService().notifyAdmins(
			'request_pending',
			{
				title: snapshot.title,
				mediaType: input.mediaType,
				tmdbId: input.tmdbId,
				posterPath: snapshot.posterPath
			},
			created.id
		);

		return this.getRequest(created.id);
	}

	/**
	 * Scope sanity against the TMDB snapshot: seasons must exist with at
	 * least one episode, episode numbers must fit inside their season's
	 * episode count. Phantom scopes would otherwise silently count zero
	 * toward quota and never be satisfiable.
	 */
	private validateScopeAgainstSnapshot(
		scope: { seasons: number[]; episodes: RequestEpisodeEntry[] },
		snapshot: TmdbSnapshot
	): void {
		for (const s of scope.seasons) {
			const count = snapshot.seasonEpisodeCounts.get(s);
			if (count === undefined || count <= 0) {
				throw new RequestError('invalid_scope', `Season ${s} does not exist for this series`, 400, {
					season: s
				});
			}
		}
		for (const ep of scope.episodes) {
			const count = snapshot.seasonEpisodeCounts.get(ep.seasonNumber);
			if (count === undefined || count < ep.episodeNumber) {
				throw new RequestError(
					'invalid_scope',
					`Episode ${ep.seasonNumber}x${ep.episodeNumber} does not exist for this series`,
					400,
					{ season: ep.seasonNumber, episode: ep.episodeNumber }
				);
			}
		}
	}

	private normalizeScope(input: CreateRequestInput) {
		const seasons = [
			...new Set((input.seasons ?? []).filter((s) => Number.isInteger(s) && s > 0))
		].sort((a, b) => a - b);
		const seen = new Set<string>();
		const episodes: RequestEpisodeEntry[] = [];
		for (const ep of input.episodes ?? []) {
			if (!Number.isInteger(ep.seasonNumber) || ep.seasonNumber <= 0) continue;
			if (!Number.isInteger(ep.episodeNumber) || ep.episodeNumber < 1) continue;
			const key = `${ep.seasonNumber}x${ep.episodeNumber}`;
			if (seen.has(key)) continue;
			seen.add(key);
			episodes.push({ seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber });
		}
		if (input.mediaType === 'series' && seasons.length === 0 && episodes.length === 0) {
			throw new RequestError(
				'invalid_scope',
				'A series request needs at least one season or episode',
				400
			);
		}
		return { seasons, episodes };
	}

	private async fetchSnapshot(
		mediaType: 'movie' | 'series',
		tmdbId: number
	): Promise<TmdbSnapshot> {
		if (mediaType === 'movie') {
			const details = await fetchMovieDetails(tmdbId);
			return {
				title: details.title,
				posterPath: details.poster_path ?? null,
				year: details.release_date ? new Date(details.release_date).getFullYear() : null,
				seasonEpisodeCounts: new Map(),
				isAnime: isLikelyAnimeMedia({
					genres: details.genres,
					originalLanguage: details.original_language,
					originCountries: details.production_countries?.map((c) => c.iso_3166_1),
					productionCountries: details.production_countries,
					title: details.title,
					originalTitle: details.original_title
				})
			};
		}
		const details = await fetchSeriesDetails(tmdbId);
		const seasonEpisodeCounts = new Map<number, number>();
		for (const s of details.seasons ?? []) {
			seasonEpisodeCounts.set(s.season_number, s.episode_count ?? 0);
		}
		return {
			title: details.name,
			posterPath: details.poster_path ?? null,
			year: details.first_air_date ? new Date(details.first_air_date).getFullYear() : null,
			seasonEpisodeCounts,
			isAnime: isLikelyAnimeMedia({
				genres: details.genres,
				originalLanguage: details.original_language,
				originCountries: details.origin_country,
				productionCountries: details.production_countries,
				title: details.name,
				originalTitle: details.original_name
			})
		};
	}

	/**
	 * Applies the in-library rules (spec §11): movie available -> hard error;
	 * movie wanted-already -> hard error unless unmonitored; series scope is
	 * filtered down to episodes that do not yet have files.
	 */
	private async computeEffectiveScope(
		mediaType: 'movie' | 'series',
		tmdbId: number,
		scope: { seasons: number[]; episodes: RequestEpisodeEntry[] }
	) {
		if (mediaType === 'movie') {
			const [movie] = await db
				.select({ id: movies.id, hasFile: movies.hasFile, monitored: movies.monitored })
				.from(movies)
				.where(eq(movies.tmdbId, tmdbId))
				.limit(1);
			if (movie) {
				if (movie.hasFile) {
					throw new RequestError('already_available', 'Movie is already in the library', 409);
				}
				if (movie.monitored) {
					throw new RequestError(
						'already_in_library',
						'Movie is already in the library and monitored',
						409
					);
				}
			}
			return scope;
		}

		const [existingSeries] = await db
			.select({ id: series.id })
			.from(series)
			.where(eq(series.tmdbId, tmdbId))
			.limit(1);
		if (!existingSeries) return scope;

		const episodeRows = await db
			.select({
				seasonNumber: episodes.seasonNumber,
				episodeNumber: episodes.episodeNumber,
				hasFile: episodes.hasFile
			})
			.from(episodes)
			.where(eq(episodes.seriesId, existingSeries.id));

		const availableEpisodes = new Set(
			episodeRows.filter((e) => e.hasFile).map((e) => `${e.seasonNumber}x${e.episodeNumber}`)
		);

		// Whole-season entries stay (their unaired/missing episodes still
		// matter); episode entries that already have files are dropped.
		const keptEpisodes = scope.episodes.filter(
			(ep) => !availableEpisodes.has(`${ep.seasonNumber}x${ep.episodeNumber}`)
		);
		if (scope.seasons.length === 0 && keptEpisodes.length === 0) {
			throw new RequestError(
				'already_available',
				'All selected episodes are already in the library',
				409
			);
		}
		return { seasons: scope.seasons, episodes: keptEpisodes };
	}

	/**
	 * Overlap is containment-aware in both directions: a whole-season entry
	 * covers every episode of that season, so a new episode collides with an
	 * existing season request and vice versa.
	 */
	private findScopeOverlap(
		a: { seasons: number[]; episodes: RequestEpisodeEntry[] },
		others: { seasons: number[]; episodes: RequestEpisodeEntry[] }[]
	): Record<string, unknown> | null {
		const aSeasons = new Set(a.seasons);
		const aEpisodes = new Set(a.episodes.map((e) => `${e.seasonNumber}x${e.episodeNumber}`));
		const seasons = new Set<number>();
		const episodes = new Set<string>();
		for (const other of others) {
			for (const s of other.seasons) {
				if (aSeasons.has(s)) seasons.add(s);
				// Other's season covers the new request's episodes in it.
				for (const key of aEpisodes) {
					if (key.startsWith(`${s}x`)) episodes.add(key);
				}
			}
			for (const e of other.episodes) {
				const key = `${e.seasonNumber}x${e.episodeNumber}`;
				if (aEpisodes.has(key)) episodes.add(key);
				// Other's episode falls inside the new request's season.
				if (aSeasons.has(e.seasonNumber)) episodes.add(key);
			}
		}
		if (seasons.size === 0 && episodes.size === 0) return null;
		return { seasons: [...seasons], episodes: [...episodes] };
	}

	// ---------------------------------------------------------------------------
	// Decisions
	// ---------------------------------------------------------------------------

	async approve(requestId: string, admin: RequesterContext) {
		return this.approveInternal(requestId, admin, false);
	}

	/**
	 * @param actor null for system re-drives (awaiting-target sweep); such
	 * approvals record no decidedBy instead of faking a user FK.
	 */
	private async approveInternal(
		requestId: string,
		actor: RequesterContext | null,
		autoApproved: boolean
	) {
		const request = await this.getRequest(requestId);
		if (!['pending', 'awaiting_target', 'failed'].includes(request.status)) {
			throw new RequestError(
				'invalid_status',
				`Cannot approve a request in status ${request.status}`,
				409
			);
		}

		// Claim the transition atomically: a concurrent approve (an admin
		// racing the awaiting-target sweep) must neither duplicate the add
		// work nor overwrite the winner's outcome with a failure.
		const claimedAt = new Date().toISOString();
		const claimed = await db
			.update(requests)
			.set({
				status: 'approved',
				decidedBy: actor?.id ?? null,
				autoApproved,
				decidedAt: claimedAt,
				expiresAt: null,
				failureReason: null,
				updatedAt: claimedAt
			})
			.where(
				and(
					eq(requests.id, requestId),
					inArray(requests.status, ['pending', 'awaiting_target', 'failed'])
				)
			)
			.returning({ id: requests.id });
		if (claimed.length === 0) {
			const current = await this.getRequest(requestId);
			throw new RequestError(
				'invalid_status',
				`Cannot approve a request in status ${current.status}`,
				409
			);
		}

		try {
			const targetFolderId = await this.resolveTargetRootFolder(
				request.mediaType as 'movie' | 'series',
				request.tmdbId
			);
			if (!targetFolderId) {
				await this.setStatus(request, 'awaiting_target', {
					failureReason: 'No writable root folder is configured for this media type'
				});
				return this.getRequest(requestId);
			}

			if (request.mediaType === 'movie') {
				await this.approveMovie(request, targetFolderId);
			} else {
				await this.approveSeries(request, targetFolderId);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Approval failed';
			await this.setStatus(request, 'failed', { failureReason: message });
			await getRequestNotificationService().notifyAdmins(
				'request_failed',
				{ title: request.title, mediaType: request.mediaType, reason: message },
				request.id
			);
			requestStreamEvents.emitRefresh({
				requesterId: request.requestedBy,
				requestId: request.id,
				timestamp: new Date().toISOString()
			});
			return this.getRequest(requestId);
		}

		const updated = await this.getRequest(requestId);

		// The predicate may already be satisfied (e.g. media landed while the
		// request waited, or the add path found everything present).
		const fulfilled = await this.evaluatePredicate(updated);
		if (fulfilled) {
			await this.markFulfilled(updated, 'request_fulfilled');
		} else {
			await getRequestNotificationService().notifyUser(
				request.requestedBy,
				autoApproved ? 'request_approved_auto' : 'request_approved',
				{ title: request.title, mediaType: request.mediaType },
				request.id
			);
		}

		requestStreamEvents.emitRefresh({
			requesterId: request.requestedBy,
			requestId: request.id,
			timestamp: claimedAt
		});
		return this.getRequest(requestId);
	}

	private async approveMovie(
		request: { id: string; tmdbId: number; title: string },
		targetFolderId: string
	) {
		const [existing] = await db
			.select({
				id: movies.id,
				monitored: movies.monitored,
				tmdbId: movies.tmdbId,
				imdbId: movies.imdbId,
				title: movies.title,
				year: movies.year,
				scoringProfileId: movies.scoringProfileId
			})
			.from(movies)
			.where(eq(movies.tmdbId, request.tmdbId))
			.limit(1);

		if (existing) {
			if (!existing.monitored) {
				await db.update(movies).set({ monitored: true }).where(eq(movies.id, existing.id));
			}
			await db.update(requests).set({ movieId: existing.id }).where(eq(requests.id, request.id));
			await triggerMovieSearch({
				movieId: existing.id,
				tmdbId: existing.tmdbId,
				imdbId: existing.imdbId ?? null,
				title: existing.title,
				year: existing.year ?? undefined,
				scoringProfileId: existing.scoringProfileId ?? undefined
			});
			return;
		}

		const result = await addMovieToLibrary({
			tmdbId: request.tmdbId,
			rootFolderId: targetFolderId,
			monitored: true,
			minimumAvailability: 'released',
			availabilityDelay: 0,
			searchOnAdd: true,
			wantsSubtitles: true
		});
		await db.update(requests).set({ movieId: result.movieId }).where(eq(requests.id, request.id));
	}

	private async approveSeries(
		request: {
			id: string;
			tmdbId: number;
			seasons: number[] | null;
			episodes: RequestEpisodeEntry[] | null;
		},
		targetFolderId: string
	) {
		// TMDB may have changed since create: approval proceeds with the
		// intersection of the stored scope and what TMDB still reports, and
		// fails outright when that intersection empties (spec §11).
		const snapshot = await this.fetchSnapshot('series', request.tmdbId);
		const seasonsWithEpisodes = new Set(
			[...snapshot.seasonEpisodeCounts.entries()]
				.filter(([, count]) => count > 0)
				.map(([season]) => season)
		);
		const requestedSeasons = (request.seasons ?? []).filter((s) => seasonsWithEpisodes.has(s));
		const requestedEpisodes = (request.episodes ?? []).filter((e) => {
			const count = snapshot.seasonEpisodeCounts.get(e.seasonNumber);
			return count !== undefined && e.episodeNumber <= count;
		});
		const hadScope = (request.seasons?.length ?? 0) + (request.episodes?.length ?? 0) > 0;
		if (hadScope && requestedSeasons.length === 0 && requestedEpisodes.length === 0) {
			throw new RequestError('add_failed', 'The requested seasons no longer exist on TMDB', 409);
		}
		if (
			hadScope &&
			(requestedSeasons.length !== (request.seasons?.length ?? 0) ||
				requestedEpisodes.length !== (request.episodes?.length ?? 0))
		) {
			await db
				.update(requests)
				.set({ seasons: requestedSeasons, episodes: requestedEpisodes })
				.where(eq(requests.id, request.id));
		}

		const [existing] = await db
			.select({
				id: series.id,
				tmdbId: series.tmdbId,
				title: series.title,
				monitored: series.monitored
			})
			.from(series)
			.where(eq(series.tmdbId, request.tmdbId))
			.limit(1);

		if (existing) {
			if (!existing.monitored) {
				await db.update(series).set({ monitored: true }).where(eq(series.id, existing.id));
			}
			await this.monitorSeriesScope(existing.id, requestedSeasons, requestedEpisodes);
			await db.update(requests).set({ seriesId: existing.id }).where(eq(requests.id, request.id));
			await triggerSeriesSearch({
				seriesId: existing.id,
				tmdbId: existing.tmdbId,
				title: existing.title
			});
			await this.snapshotEpisodeCounts(request.id, existing.id, requestedSeasons);
			return;
		}

		const result = await addSeriesToLibrary({
			tmdbId: request.tmdbId,
			rootFolderId: targetFolderId,
			monitored: true,
			seasonFolder: true,
			seriesType: snapshot.isAnime ? 'anime' : 'standard',
			monitorType: 'none',
			monitorNewItems: 'none',
			monitorSpecials: false,
			monitoredSeasons: [
				...new Set([...requestedSeasons, ...requestedEpisodes.map((e) => e.seasonNumber)])
			],
			monitoredEpisodes: requestedEpisodes.length > 0 ? requestedEpisodes : undefined,
			searchOnAdd: true,
			wantsSubtitles: true
		});

		const seriesId = result.seriesId;
		await db.update(requests).set({ seriesId }).where(eq(requests.id, request.id));
		await this.snapshotEpisodeCounts(request.id, seriesId, requestedSeasons);
	}

	/** Re-monitor path for series that already exist: exact requested scope. */
	private async monitorSeriesScope(
		seriesId: string,
		requestedSeasons: number[],
		requestedEpisodes: RequestEpisodeEntry[]
	): Promise<void> {
		const seasonRows = await db
			.select({ id: seasons.id, seasonNumber: seasons.seasonNumber })
			.from(seasons)
			.where(eq(seasons.seriesId, seriesId));
		const seasonsToMonitor = new Set([
			...requestedSeasons,
			...requestedEpisodes.map((e) => e.seasonNumber)
		]);
		for (const row of seasonRows) {
			if (seasonsToMonitor.has(row.seasonNumber)) {
				await db.update(seasons).set({ monitored: true }).where(eq(seasons.id, row.id));
			}
		}
		for (const ep of requestedEpisodes) {
			await db
				.update(episodes)
				.set({ monitored: true })
				.where(
					and(
						eq(episodes.seriesId, seriesId),
						eq(episodes.seasonNumber, ep.seasonNumber),
						eq(episodes.episodeNumber, ep.episodeNumber)
					)
				);
		}
	}

	private async snapshotEpisodeCounts(
		requestId: string,
		seriesId: string,
		requestedSeasons: number[]
	): Promise<void> {
		if (requestedSeasons.length === 0) return;
		const rows = await db
			.select({ seasonNumber: episodes.seasonNumber, count: sql<number>`count(*)` })
			.from(episodes)
			.where(and(eq(episodes.seriesId, seriesId), inArray(episodes.seasonNumber, requestedSeasons)))
			.groupBy(episodes.seasonNumber);
		const snapshot = rows.map((r) => ({ season: r.seasonNumber, count: r.count }));
		await db
			.update(requests)
			.set({ episodeCountSnapshot: snapshot })
			.where(eq(requests.id, requestId));
	}

	/**
	 * Target resolution: a writable root folder for the media type, preferring
	 * the anime/standard subtype match and then the isDefault flag. Returns
	 * null when no candidate exists (caller parks the request).
	 */
	private async resolveTargetRootFolder(
		mediaType: 'movie' | 'series',
		tmdbId: number
	): Promise<string | null> {
		const folderMediaType = mediaType === 'movie' ? 'movie' : 'tv';
		const candidates = await db
			.select({
				id: rootFolders.id,
				mediaSubType: rootFolders.mediaSubType,
				isDefault: rootFolders.isDefault,
				readOnly: rootFolders.readOnly
			})
			.from(rootFolders)
			.where(and(eq(rootFolders.mediaType, folderMediaType), eq(rootFolders.readOnly, false)));

		if (candidates.length === 0) return null;

		const snapshot = await this.fetchSnapshot(mediaType, tmdbId);
		const wantedSubType = snapshot.isAnime ? 'anime' : 'standard';
		const subtypeMatch = candidates.filter((c) => c.mediaSubType === wantedSubType);
		const pool = subtypeMatch.length > 0 ? subtypeMatch : candidates;
		return (pool.find((c) => c.isDefault) ?? pool[0]).id;
	}

	async decline(requestId: string, admin: RequesterContext, reason: string) {
		const request = await this.getRequest(requestId);
		if (!['pending', 'awaiting_target', 'approved', 'failed'].includes(request.status)) {
			throw new RequestError(
				'invalid_status',
				`Cannot decline a request in status ${request.status}`,
				409
			);
		}
		const now = new Date().toISOString();
		const claimed = await db
			.update(requests)
			.set({
				status: 'declined',
				declineReason: reason,
				failureReason: null,
				decidedAt: now,
				updatedAt: now
			})
			.where(
				and(
					eq(requests.id, requestId),
					inArray(requests.status, ['pending', 'awaiting_target', 'approved', 'failed'])
				)
			)
			.returning({ id: requests.id });
		if (claimed.length === 0) {
			const current = await this.getRequest(requestId);
			throw new RequestError(
				'invalid_status',
				`Cannot decline a request in status ${current.status}`,
				409
			);
		}
		await getRequestNotificationService().notifyUser(
			request.requestedBy,
			'request_declined',
			{ title: request.title, mediaType: request.mediaType, reason },
			request.id
		);
		requestStreamEvents.emitRefresh({
			requesterId: request.requestedBy,
			requestId: request.id,
			timestamp: new Date().toISOString()
		});
		return this.getRequest(requestId);
	}

	async cancel(requestId: string, requester: RequesterContext) {
		const request = await this.getRequest(requestId);
		const isOwner = request.requestedBy === requester.id;
		const isAdmin = requester.role === 'admin';
		if (!isOwner && !isAdmin) {
			throw new RequestError('not_found', 'Request not found', 404);
		}
		if (request.status !== 'pending') {
			throw new RequestError('invalid_status', 'Only pending requests can be cancelled', 409);
		}
		const now = new Date().toISOString();
		const claimed = await db
			.update(requests)
			.set({ status: 'cancelled', decidedAt: now, updatedAt: now })
			.where(and(eq(requests.id, requestId), eq(requests.status, 'pending')))
			.returning({ id: requests.id });
		if (claimed.length === 0) {
			const current = await this.getRequest(requestId);
			throw new RequestError(
				'invalid_status',
				`Cannot cancel a request in status ${current.status}`,
				409
			);
		}
		requestStreamEvents.emitRefresh({
			requesterId: request.requestedBy,
			requestId: request.id,
			timestamp: new Date().toISOString()
		});
		return this.getRequest(requestId);
	}

	async retry(requestId: string, admin: RequesterContext) {
		const request = await this.getRequest(requestId);
		if (request.status !== 'failed') {
			throw new RequestError('invalid_status', 'Only failed requests can be retried', 409);
		}
		return this.approveInternal(requestId, admin, false);
	}

	/**
	 * DELETE verb: a pending request is cancelled (the row stays as the
	 * decision record); a decided one is removed outright. Active non-pending
	 * statuses fall into cancel's invalid_status 409 — approve/decline/retry
	 * are the verbs there.
	 */
	async cancelOrRemove(
		requestId: string,
		requester: RequesterContext
	): Promise<{ kind: 'cancelled'; request: typeof requests.$inferSelect } | { kind: 'removed' }> {
		const request = await this.getRequest(requestId);
		// `failed` stays an ACTIVE status (it blocks duplicates and carries the
		// Retry action), but unlike the other active statuses it is also
		// owner-removable — e.g. requests failed by media deletion, where the
		// requester prefers a fresh request over a retry.
		const cancellable =
			(ACTIVE_REQUEST_STATUSES as readonly string[]).includes(request.status) &&
			request.status !== 'failed';
		if (cancellable) {
			return { kind: 'cancelled', request: await this.cancel(requestId, requester) };
		}
		// Terminal: owner or admin may clear the row; the conditional delete
		// keeps a racing decline/expiry from being silently resurrected.
		const isOwner = request.requestedBy === requester.id;
		if (!isOwner && requester.role !== 'admin') {
			throw new RequestError('not_found', 'Request not found', 404);
		}
		const claimed = await db
			.delete(requests)
			.where(
				and(eq(requests.id, request.id), inArray(requests.status, [...TERMINAL_REQUEST_STATUSES]))
			)
			.returning({ id: requests.id });
		if (claimed.length === 0) {
			const current = await this.getRequest(requestId);
			throw new RequestError(
				'invalid_status',
				`Cannot remove a request in status ${current.status}`,
				409
			);
		}
		requestStreamEvents.emitRefresh({
			requesterId: request.requestedBy,
			requestId: request.id,
			timestamp: new Date().toISOString()
		});
		return { kind: 'removed' };
	}

	async markFulfilledAdmin(requestId: string) {
		const request = await this.getRequest(requestId);
		if (['declined', 'expired', 'cancelled', 'fulfilled'].includes(request.status)) {
			throw new RequestError(
				'invalid_status',
				`Cannot fulfill a request in status ${request.status}`,
				409
			);
		}
		const now = new Date().toISOString();
		const claimed = await db
			.update(requests)
			.set({ status: 'fulfilled', fulfilledAt: now, updatedAt: now })
			.where(
				and(
					eq(requests.id, requestId),
					inArray(requests.status, ['pending', 'approved', 'awaiting_target', 'failed'])
				)
			)
			.returning({ id: requests.id });
		if (claimed.length === 0) {
			const current = await this.getRequest(requestId);
			throw new RequestError(
				'invalid_status',
				`Cannot fulfill a request in status ${current.status}`,
				409
			);
		}
		await getRequestNotificationService().notifyUser(
			request.requestedBy,
			'request_fulfilled',
			{ title: request.title, mediaType: request.mediaType, status: 'fulfilled' },
			request.id
		);
		requestStreamEvents.emitRefresh({
			requesterId: request.requestedBy,
			requestId: request.id,
			timestamp: now
		});
		return this.getRequest(requestId);
	}

	// ---------------------------------------------------------------------------
	// Availability predicate (used by the projector and post-approval)
	// ---------------------------------------------------------------------------

	/**
	 * Movie: single-quality -> hasFile; multi-quality -> every effective
	 * desiredQualities bucket filled. Series: every scope episode has a file
	 * (unaired episodes keep the request open; monitoring acquires them).
	 */
	async evaluatePredicate(request: {
		id: string;
		mediaType: string;
		tmdbId: number;
		movieId: string | null;
		seriesId: string | null;
		seasons: number[] | null;
		episodes: RequestEpisodeEntry[] | null;
	}): Promise<boolean> {
		if (request.mediaType === 'movie') {
			const movieId = request.movieId ?? (await this.findMovieId(request.tmdbId));
			if (!movieId) return false;
			const [movie] = await db
				.select({
					hasFile: movies.hasFile,
					desiredQualities: movies.desiredQualities,
					scoringProfileId: movies.scoringProfileId
				})
				.from(movies)
				.where(eq(movies.id, movieId))
				.limit(1);
			if (!movie) return false;
			if (!movie.hasFile) return false;

			const context = await resolveMovieMultiQuality(
				(movie.desiredQualities as never) ?? null,
				movie.scoringProfileId ?? null
			);
			if (!context.multiQuality) return true;

			const files = await db
				.select({ quality: movieFiles.quality })
				.from(movieFiles)
				.where(eq(movieFiles.movieId, movieId));
			const filled = new Set(
				files.map((f) => f.quality?.resolution).filter((r): r is string => typeof r === 'string')
			);
			return context.effective.every((bucket) => filled.has(bucket));
		}

		const seriesId = request.seriesId ?? (await this.findSeriesId(request.tmdbId));
		if (!seriesId) return false;

		const rows = await db
			.select({
				seasonNumber: episodes.seasonNumber,
				episodeNumber: episodes.episodeNumber,
				hasFile: episodes.hasFile
			})
			.from(episodes)
			.where(eq(episodes.seriesId, seriesId));

		const byKey = new Map(rows.map((r) => [`${r.seasonNumber}x${r.episodeNumber}`, r.hasFile]));

		for (const ep of request.episodes ?? []) {
			if (!byKey.get(`${ep.seasonNumber}x${ep.episodeNumber}`)) return false;
		}
		for (const season of request.seasons ?? []) {
			const seasonRows = rows.filter((r) => r.seasonNumber === season);
			if (seasonRows.length === 0) return false;
			if (!seasonRows.every((r) => r.hasFile)) return false;
		}
		return true;
	}

	private async findMovieId(tmdbId: number): Promise<string | null> {
		const [row] = await db
			.select({ id: movies.id })
			.from(movies)
			.where(eq(movies.tmdbId, tmdbId))
			.limit(1);
		return row?.id ?? null;
	}

	private async findSeriesId(tmdbId: number): Promise<string | null> {
		const [row] = await db
			.select({ id: series.id })
			.from(series)
			.where(eq(series.tmdbId, tmdbId))
			.limit(1);
		return row?.id ?? null;
	}

	/**
	 * Fulfillment is claimed conditionally on the row still being in an
	 * active state: a concurrent decline (or the TTL sweep) must win over a
	 * projector race, and vice versa. Notification fires only when this
	 * call performed the transition.
	 */
	private async markFulfilled(
		request: { id: string; requestedBy: string; title: string; mediaType: string },
		event: 'request_fulfilled'
	): Promise<void> {
		const now = new Date().toISOString();
		const claimed = await db
			.update(requests)
			.set({ status: 'fulfilled', fulfilledAt: now, updatedAt: now })
			.where(
				and(
					eq(requests.id, request.id),
					inArray(requests.status, ['pending', 'approved', 'awaiting_target'])
				)
			)
			.returning({ id: requests.id });
		if (claimed.length === 0) return;
		await getRequestNotificationService().notifyUser(
			request.requestedBy,
			event,
			{ title: request.title, mediaType: request.mediaType, status: 'fulfilled' },
			request.id
		);
	}

	/**
	 * Fulfill any pending/approved request whose media is now available.
	 * Called by the projector on library events and by the sweep. A pending
	 * request fulfilled this way skips approval entirely — the media exists.
	 */
	async advanceFulfilledByMedia(mediaType: 'movie' | 'series', tmdbId: number): Promise<number> {
		const active = await db
			.select()
			.from(requests)
			.where(
				and(
					eq(requests.mediaType, mediaType),
					eq(requests.tmdbId, tmdbId),
					inArray(requests.status, ['pending', 'approved', 'awaiting_target'])
				)
			);
		let count = 0;
		for (const request of active) {
			// Link ids opportunistically first so fulfilled rows carry them.
			if (!request.movieId && !request.seriesId) {
				const linkId =
					mediaType === 'movie' ? await this.findMovieId(tmdbId) : await this.findSeriesId(tmdbId);
				if (linkId) {
					await db
						.update(requests)
						.set(mediaType === 'movie' ? { movieId: linkId } : { seriesId: linkId })
						.where(eq(requests.id, request.id));
					if (mediaType === 'movie') {
						request.movieId = linkId;
					} else {
						request.seriesId = linkId;
					}
				}
			}
			if (await this.evaluatePredicate(request)) {
				await this.markFulfilled(request, 'request_fulfilled');
				requestStreamEvents.emitRefresh({
					requesterId: request.requestedBy,
					requestId: request.id,
					timestamp: new Date().toISOString()
				});
				count++;
			}
		}
		return count;
	}

	/** Re-drive awaiting_target requests (called when targets may exist). */
	async retryAwaitingTarget(): Promise<number> {
		const parked = await db
			.select({ id: requests.id, autoApproved: requests.autoApproved })
			.from(requests)
			.where(eq(requests.status, 'awaiting_target'));
		let advanced = 0;
		for (const row of parked) {
			// System re-drive: no actor, but the original auto-approve
			// provenance is preserved for the audit trail.
			const result = await this.approveInternal(row.id, null, row.autoApproved);
			if (result && result.status !== 'awaiting_target') advanced++;
		}
		return advanced;
	}

	/**
	 * Fail requests orphaned by media deletion. Approval always stamps the
	 * library id, and only the requests FK (ON DELETE SET NULL) clears it —
	 * so `approved` with both ids null is exactly the deleted-after-approval
	 * class, whether the delete came from the admin UI, bulk actions, or
	 * scan-driven removal. `failed` is not an active status, so re-requesting
	 * the title unlocks; nothing auto-retries a failed row. Called from the
	 * hourly sweep.
	 */
	async reconcileDeletedMedia(): Promise<number> {
		const orphaned = await db
			.select()
			.from(requests)
			.where(
				and(eq(requests.status, 'approved'), isNull(requests.movieId), isNull(requests.seriesId))
			);
		let failed = 0;
		for (const request of orphaned) {
			const claimed = await db
				.update(requests)
				.set({
					status: 'failed',
					failureReason: 'Library item was deleted',
					updatedAt: new Date().toISOString()
				})
				.where(and(eq(requests.id, request.id), eq(requests.status, 'approved')))
				.returning({ id: requests.id });
			if (claimed.length === 0) continue;
			failed++;

			await getRequestNotificationService().notifyUser(
				request.requestedBy,
				'request_failed',
				{
					title: request.title,
					mediaType: request.mediaType,
					reason: 'Library item was deleted'
				},
				request.id
			);
			requestStreamEvents.emitRefresh({
				requesterId: request.requestedBy,
				requestId: request.id,
				timestamp: new Date().toISOString()
			});
		}
		return failed;
	}

	// ---------------------------------------------------------------------------
	// TTL sweep
	// ---------------------------------------------------------------------------

	async expireStalePending(): Promise<number> {
		const nowIso = new Date().toISOString();
		const stale = await db
			.select()
			.from(requests)
			.where(
				and(
					eq(requests.status, 'pending'),
					isNotNull(requests.expiresAt),
					sql`${requests.expiresAt} <= ${nowIso}`
				)
			);
		let expired = 0;
		for (const request of stale) {
			// Conditional update: a request approved between the select and
			// this write must not be expired underneath the approver.
			const claimed = await db
				.update(requests)
				.set({
					status: 'expired',
					declineReason: 'expired',
					decidedAt: nowIso,
					updatedAt: nowIso
				})
				.where(and(eq(requests.id, request.id), eq(requests.status, 'pending')))
				.returning({ id: requests.id });
			if (claimed.length === 0) continue;
			expired++;
			await getRequestNotificationService().notifyUser(
				request.requestedBy,
				'request_expired',
				{ title: request.title, mediaType: request.mediaType },
				request.id
			);
			requestStreamEvents.emitRefresh({
				requesterId: request.requestedBy,
				requestId: request.id,
				timestamp: nowIso
			});
		}
		return expired;
	}

	// ---------------------------------------------------------------------------
	// Reads
	// ---------------------------------------------------------------------------

	async getRequest(requestId: string) {
		const [row] = await db.select().from(requests).where(eq(requests.id, requestId)).limit(1);
		if (!row) {
			throw new RequestError('not_found', 'Request not found', 404);
		}
		return row;
	}

	async listRequests(options: {
		requesterId?: string;
		statuses?: RequestStatus[];
		mediaType?: 'movie' | 'series';
		take?: number;
		skip?: number;
		sort?: 'added' | 'modified';
	}) {
		const conditions = [];
		if (options.requesterId) {
			conditions.push(eq(requests.requestedBy, options.requesterId));
		}
		if (options.statuses && options.statuses.length > 0) {
			conditions.push(inArray(requests.status, options.statuses));
		}
		if (options.mediaType) {
			conditions.push(eq(requests.mediaType, options.mediaType));
		}
		// Sanitized pagination: floor + clamp so negative or fractional
		// values can never become an unlimited/negative SQLite LIMIT-OFFSET.
		const take = Math.floor(Math.min(Math.max(options.take ?? 50, 1), 100));
		const skip = Math.floor(Math.max(options.skip ?? 0, 0));
		return db
			.select()
			.from(requests)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(options.sort === 'modified' ? desc(requests.updatedAt) : desc(requests.createdAt))
			.limit(take)
			.offset(skip);
	}

	/**
	 * Distinct (mediaType, tmdbId) pairs of active requests — the sweep's
	 * work list. Keyed on identity rather than the 100 newest rows so an
	 * active request is never starved from fulfillment projection.
	 */
	async listActiveMediaKeys(): Promise<Array<{ mediaType: 'movie' | 'series'; tmdbId: number }>> {
		const rows = await db
			.selectDistinct({ mediaType: requests.mediaType, tmdbId: requests.tmdbId })
			.from(requests)
			.where(inArray(requests.status, [...ACTIVE_REQUEST_STATUSES]));
		return rows.map((r) => ({
			mediaType: r.mediaType === 'movie' ? 'movie' : 'series',
			tmdbId: r.tmdbId
		}));
	}

	async countByStatus(): Promise<Record<string, number>> {
		const rows = await db
			.select({ status: requests.status, count: sql<number>`count(*)` })
			.from(requests)
			.groupBy(requests.status);
		const result: Record<string, number> = {};
		for (const row of rows) {
			result[row.status] = row.count;
		}
		return result;
	}

	private async setStatus(
		request: { id: string },
		status: RequestStatus,
		extra: { declineReason?: string; failureReason?: string | null }
	) {
		const now = new Date().toISOString();
		await db
			.update(requests)
			.set({
				status,
				declineReason: extra.declineReason ?? null,
				failureReason: extra.failureReason ?? null,
				decidedAt: ['declined', 'expired', 'cancelled', 'approved', 'awaiting_target'].includes(
					status
				)
					? now
					: undefined,
				updatedAt: now
			})
			.where(eq(requests.id, request.id));
	}
}

let _instance: RequestService | null = null;

export function getRequestService(): RequestService {
	if (!_instance) {
		_instance = new RequestService();
	}
	return _instance;
}

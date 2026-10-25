import { randomUUID } from 'node:crypto';
import { grabDecisionPipeline } from '#lib/server/filters/GrabDecisionPipeline.js';
import { qualityFilter } from '#lib/server/quality/QualityFilter.js';
import { db } from '#lib/server/db/index.js';
import {
	movies,
	series,
	episodes,
	movieFiles,
	episodeFiles,
	rootFolders,
	alternateTitles,
	rejectedReleases,
	downloadHistory
} from '#lib/server/db/schema.js';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { GrabRequest, GrabResult, ResolvedContext, HandlerResult } from './grab-types.js';
import type { GrabDecisionContext, ExistingFile } from '#lib/server/filters/stages/grab/types.js';
import { mediaOccupancyService } from '#lib/server/acquisition/MediaOccupancyService.js';
import { TorrentHandler } from './handlers/TorrentHandler.js';
import { UsenetHandler } from './handlers/UsenetHandler.js';
import { StreamingHandler } from './handlers/StreamingHandler.js';
import { NzbStreamingHandler } from './handlers/NzbStreamingHandler.js';
import { DebridHandler } from './handlers/DebridHandler.js';
import { getDefaultAcquisitionProtocol } from '#lib/server/settings/acquisition.js';
import { createChildLogger, getRequestId } from '#lib/logging/index.js';
import { grabRejectionLogLevel } from './grab-rejection-log-level.js';
import { resolveInfoHash } from '#lib/server/downloadClients/utils/hashUtils.js';
import { normalizeIdentityTitle } from '#lib/server/releases/release-identity.js';
import type { TargetIdentityInfo } from '#lib/server/filters/stages/grab/types.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import type { CreateIntentResult } from '#lib/server/acquisition/AcquisitionService.js';
import { computeMovieQualitySlot } from '#lib/server/acquisition/slot-keys.js';
import { parseRelease } from '#lib/server/indexers/parser/index.js';

const logger = createChildLogger({ module: 'GrabService', logDomain: 'downloads' });

const grabHashLocks = new Map<string, Promise<void>>();

async function withGrabHashLock<T>(
	infoHash: string | undefined,
	operation: () => Promise<T>
): Promise<T> {
	if (!infoHash) return operation();

	const previous = grabHashLocks.get(infoHash);
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	grabHashLocks.set(infoHash, current);

	if (previous) await previous;
	try {
		return await operation();
	} finally {
		release();
		if (grabHashLocks.get(infoHash) === current) grabHashLocks.delete(infoHash);
	}
}

class GrabServiceImpl {
	private static instance: GrabServiceImpl;

	static getInstance(): GrabServiceImpl {
		if (!GrabServiceImpl.instance) {
			GrabServiceImpl.instance = new GrabServiceImpl();
		}
		return GrabServiceImpl.instance;
	}

	async grab(request: GrabRequest, opts?: { forceOverride?: boolean }): Promise<GrabResult> {
		const infoHash = resolveInfoHash(
			request.release.infoHash,
			request.release.magnetUrl,
			request.release.downloadUrl
		);
		return withGrabHashLock(infoHash, () =>
			mediaOccupancyService.runExclusive(request.target, () =>
				this.grabUnlocked(request, opts?.forceOverride ?? false)
			)
		);
	}

	private async grabUnlocked(request: GrabRequest, forceOverride = false): Promise<GrabResult> {
		const { release, target, options } = request;

		const resolved = await this.resolveTarget(request);

		// When force-overriding, skip policy scoring — but identity is never
		// skippable and the acquisition still reserves its slot.
		if (forceOverride) {
			// Explicit admin override: the hard stages are intentionally skipped
			// (documented override path), unlike plain manual `force` grabs.
			options.overrideHardStages = true;

			const overrideExistingFiles = await this.getExistingFiles(request);
			const identity = await grabDecisionPipeline.evaluateIdentity({
				release,
				target,
				existingFiles: overrideExistingFiles,
				profile: resolved.profile,
				options,
				desiredQualities: resolved.desiredQualities,
				targetInfo: resolved.targetInfo,
				computed: {}
			});
			if (!identity.accepted) {
				logger.warn(
					{ title: release.title, reason: identity.reason },
					'[Grab] Override rejected by identity stage'
				);
				return {
					success: false,
					decision: {
						accepted: false,
						reason: identity.reason ?? 'Release does not match the target media',
						rejectionType: 'identity_mismatch',
						upgradeStatus: 'rejected',
						scores: { candidate: 0 },
						audit: { stages: [], finalResult: { accepted: false }, totalDurationMs: 0 }
					},
					error: identity.reason ?? 'Release does not match the target media'
				};
			}

			const reservation = await this.reserveSlot(request, resolved, undefined, 'override');
			if (!reservation.ok) {
				return this.conflictResult(reservation);
			}
			const intentId = reservation.intentId;
			options.intentId = intentId;

			let handlerResult: HandlerResult;
			try {
				handlerResult = await this.routeByProtocol(request, resolved);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				acquisitionService.failIntent(intentId, message);
				logger.error({ title: release.title, error: message }, '[Grab] Override handler threw');
				return {
					success: false,
					decision: {
						accepted: false,
						reason: message,
						upgradeStatus: 'rejected',
						scores: { candidate: 0 },
						audit: { stages: [], finalResult: { accepted: false }, totalDurationMs: 0 }
					},
					error: message
				};
			}
			if (!handlerResult.success) {
				acquisitionService.failIntent(intentId, handlerResult.error ?? 'Handler failed');
				logger.error(
					{ title: release.title, error: handlerResult.error },
					'[Grab] Override handler failed'
				);
				return {
					success: false,
					decision: {
						accepted: false,
						reason: handlerResult.error ?? 'Handler failed',
						upgradeStatus: 'rejected',
						scores: { candidate: 0 },
						audit: { stages: [], finalResult: { accepted: false }, totalDurationMs: 0 }
					},
					error: handlerResult.error
				};
			}
			this.linkIntentToResult(request, intentId, handlerResult.queueId);
			return {
				success: true,
				decision: {
					accepted: true,
					reason: 'force_override',
					upgradeStatus: 'new',
					scores: { candidate: 0 },
					audit: { stages: [], finalResult: { accepted: true }, totalDurationMs: 0 }
				},
				download: {
					queueId: handlerResult.queueId!,
					hash: handlerResult.hash,
					clientId: handlerResult.clientId!,
					clientName: handlerResult.clientName!,
					category: handlerResult.category ?? (resolved.mediaType === 'movie' ? 'movies' : 'tv'),
					addedToQueue: handlerResult.wasDuplicate !== true,
					wasDuplicate: handlerResult.wasDuplicate ?? false,
					isUpgrade: false
				}
			};
		}

		const existingFiles = await this.getExistingFiles(request);

		const ctx: GrabDecisionContext = {
			release,
			target,
			existingFiles,
			profile: resolved.profile,
			options,
			desiredQualities: resolved.desiredQualities,
			targetInfo: resolved.targetInfo,
			computed: {}
		};

		const decision = await grabDecisionPipeline.evaluate(ctx);

		if (!decision.accepted) {
			const rejectionCtx = {
				title: release.title,
				rejectionType: decision.rejectionType,
				reason: decision.reason,
				stage: decision.audit.stages.find((s) => !s.skipped && s.result && !s.result.accepted)
					?.name,
				indexerId: release.indexerId,
				indexerName: release.indexerName,
				protocol: release.protocol,
				mediaType: resolved.mediaType,
				candidateScore: decision.scores.candidate,
				existingScore: decision.scores.existing,
				isAutomatic: options.isAutomatic,
				target
			};
			const level = grabRejectionLogLevel(options.isAutomatic);
			if (level === 'warn') {
				logger.warn(rejectionCtx, '[Grab] Release rejected');
			} else {
				logger.debug(rejectionCtx, '[Grab] Release rejected (automated search)');
			}

			// Persist rejection for diagnostic reports (fire-and-forget)
			this.persistRejectedRelease(release, resolved, decision).catch((err) =>
				logger.warn({ err }, '[Grab] Failed to persist rejected release record')
			);

			return { success: false, decision };
		}

		// Reserve the target slot with the pipeline-COMPUTED decision. The
		// intent is the durable acquisition authority; queue rows become a
		// transport projection linked via queueId. Slot exclusivity is
		// DB-enforced and applies to manual grabs too.
		const source = options.source ?? (options.isAutomatic ? 'automatic' : 'manual');
		const reservation = await this.reserveSlot(request, resolved, decision, source);
		if (!reservation.ok) {
			this.persistRejectedRelease(
				release,
				resolved,
				this.conflictResult(reservation).decision
			).catch((err) => logger.warn({ err }, '[Grab] Failed to persist rejected release record'));
			return this.conflictResult(reservation);
		}
		const intentId = reservation.intentId;
		options.intentId = intentId;

		// Handlers persist what they are given — hand them the COMPUTED
		// upgrade decision, never the caller's possibly-missing flag.
		options.isUpgrade = decision.upgradeStatus === 'upgrade';

		let handlerResult: HandlerResult;
		try {
			handlerResult = await this.routeByProtocol(request, resolved);
		} catch (error) {
			// A throwing handler must not leak the reservation/intent: fail it
			// before surfacing the error.
			const message = error instanceof Error ? error.message : String(error);
			acquisitionService.failIntent(intentId, message);
			logger.error(
				{
					title: release.title,
					error: message,
					protocol: release.protocol,
					indexerId: release.indexerId,
					isAutomatic: options.isAutomatic
				},
				'[Grab] Handler threw while adding release to download client'
			);
			this.persistFailedGrab(release, resolved, message).catch((err) =>
				logger.warn({ err }, '[Grab] Failed to persist failed grab history record')
			);

			return { success: false, decision, error: message };
		}

		if (!handlerResult.success) {
			acquisitionService.failIntent(intentId, handlerResult.error ?? 'Handler failed');
			logger.error(
				{
					title: release.title,
					error: handlerResult.error,
					protocol: release.protocol,
					indexerId: release.indexerId,
					isAutomatic: options.isAutomatic
				},
				'[Grab] Handler failed to add release to download client'
			);
			this.persistFailedGrab(release, resolved, handlerResult.error).catch((err) =>
				logger.warn({ err }, '[Grab] Failed to persist failed grab history record')
			);

			return { success: false, decision, error: handlerResult.error };
		}

		this.linkIntentToResult(request, intentId, handlerResult.queueId);

		return {
			success: true,
			decision,
			download: {
				queueId: handlerResult.queueId!,
				hash: handlerResult.hash,
				clientId: handlerResult.clientId!,
				clientName: handlerResult.clientName!,
				category: handlerResult.category ?? (resolved.mediaType === 'movie' ? 'movies' : 'tv'),
				addedToQueue: handlerResult.wasDuplicate !== true,
				wasDuplicate: handlerResult.wasDuplicate ?? false,
				isUpgrade: decision.upgradeStatus === 'upgrade'
			}
		};
	}

	/**
	 * Reserve the acquisition's target slots. Movie slots are quality-bucket
	 * aware; TV scope uses the expanded episode list from resolveTarget.
	 */
	private async reserveSlot(
		request: GrabRequest,
		resolved: ResolvedContext,
		decision: GrabResult['decision'] | undefined,
		source: 'manual' | 'automatic' | 'arr_push' | 'override'
	): Promise<CreateIntentResult> {
		const { release } = request;

		let qualitySlot = 'episodes';
		if (resolved.mediaType === 'movie') {
			const parsed = parseRelease(release.title);
			qualitySlot = await computeMovieQualitySlot(
				resolved.desiredQualities,
				resolved.profile?.id,
				parsed.resolution === 'unknown' ? undefined : parsed.resolution
			);
		}

		const infoHash = resolveInfoHash(release.infoHash, release.magnetUrl, release.downloadUrl);
		const identity = infoHash
			? ({ kind: 'info_hash', value: infoHash } as const)
			: release.guid && release.indexerId
				? ({ kind: 'indexer_guid', value: `${release.indexerId}:${release.guid}` } as const)
				: undefined;

		return acquisitionService.createIntent({
			mediaType: resolved.mediaType,
			movieId: resolved.movieId,
			seriesId: resolved.seriesId,
			seasonNumber: resolved.seasonNumber,
			episodeIds: resolved.episodeIds,
			qualitySlot,
			protocol: release.protocol ?? 'torrent',
			identity,
			releaseTitle: release.title,
			indexerId: release.indexerId,
			indexerName: release.indexerName,
			upgradeStatus: decision?.upgradeStatus,
			decision: decision
				? {
						reason: decision.reason,
						scores: decision.scores,
						upgradeStatus: decision.upgradeStatus
					}
				: undefined,
			source
		});
	}

	/**
	 * Attach the transport queue row to the intent, or — for protocols that
	 * finalize synchronously inside the handler (streaming, NZB streaming,
	 * which never enter the download queue) — complete the intent now.
	 */
	private linkIntentToResult(
		request: GrabRequest,
		intentId: string,
		queueId: string | undefined
	): void {
		const finalizesSynchronously =
			request.release.protocol === 'streaming' ||
			(request.release.protocol === 'usenet' && request.options.streamUsenet);
		if (finalizesSynchronously) {
			acquisitionService.completeIntent(intentId);
			return;
		}
		if (queueId) {
			acquisitionService.attachQueueId(intentId, queueId);
		}
	}

	/** Translate a reservation conflict into a rejection-shaped GrabResult. */
	private conflictResult(reservation: Extract<CreateIntentResult, { ok: false }>): GrabResult {
		const { kind, conflict } = reservation;
		const inQueue = conflict.queueId ? ' (active in download queue)' : '';
		const reason =
			kind === 'identity_conflict'
				? `Duplicate release: "${conflict.releaseTitle}" is already being acquired${inQueue}`
				: `Already acquiring "${conflict.releaseTitle}" for this slot${inQueue} — remove it first or wait for it to finish`;
		const rejectionType = kind === 'identity_conflict' ? 'duplicate_hash' : 'media_occupied';
		return {
			success: false,
			decision: {
				accepted: false,
				reason,
				rejectionType,
				upgradeStatus: 'rejected',
				scores: { candidate: 0 },
				audit: { stages: [], finalResult: { accepted: false, reason }, totalDurationMs: 0 }
			}
		};
	}

	private async resolveTarget(request: GrabRequest): Promise<ResolvedContext> {
		const { target } = request;
		let profileId: string | null;
		let rootFolderId: string | null;
		let mediaPath: string | undefined;
		let movieId: string | undefined;
		let seriesId: string | undefined;
		let episodeIds: string[] | undefined;
		let seasonNumber: number | undefined;
		let mediaType: 'movie' | 'tv' = 'movie';
		let movieDesiredQualities: ResolvedContext['desiredQualities'];
		let targetInfo: TargetIdentityInfo | undefined;

		if (target.type === 'movie') {
			const movie = await db.query.movies.findFirst({ where: eq(movies.id, target.movieId) });
			if (!movie) throw new Error(`Movie not found: ${target.movieId}`);
			profileId = movie.scoringProfileId;
			rootFolderId = movie.rootFolderId;
			mediaPath = movie.path ?? undefined;
			movieId = movie.id;
			movieDesiredQualities = movie.desiredQualities ?? undefined;
			targetInfo = {
				mediaType: 'movie',
				titles: await this.resolveTargetTitles('movie', movie.id, movie.title, movie.originalTitle),
				year: movie.year ?? undefined,
				tmdbId: movie.tmdbId,
				imdbId: movie.imdbId ?? null
			};
		} else {
			seriesId = 'seriesId' in target ? target.seriesId : undefined;
			const show = seriesId
				? await db.query.series.findFirst({ where: eq(series.id, seriesId) })
				: null;
			if (!show && seriesId) throw new Error(`Series not found: ${seriesId}`);
			profileId = show?.scoringProfileId ?? null;
			rootFolderId = show?.rootFolderId ?? null;
			mediaPath = show?.path ?? undefined;
			mediaType = 'tv';

			if (target.type === 'episode') {
				episodeIds = [target.episodeId];
			} else if (target.type === 'season') {
				seasonNumber = target.seasonNumber;
				episodeIds = target.episodeIds;
				// Season packs must carry a concrete episode scope. An empty
				// episodeIds list bypassed occupancy entirely and left queue
				// rows invisible to per-episode blocking checks — expand to
				// every episode of the season (the pack delivers them all).
				if (episodeIds.length === 0) {
					const seasonEpisodes = await db.query.episodes.findMany({
						where: and(
							eq(episodes.seriesId, seriesId!),
							eq(episodes.seasonNumber, target.seasonNumber)
						)
					});
					episodeIds = seasonEpisodes.map((episode) => episode.id);
				}
			} else {
				episodeIds = target.episodeIds;
				if (episodeIds.length === 0 && seriesId) {
					const conditions = [
						eq(episodes.seriesId, seriesId),
						eq(episodes.hasFile, false),
						ne(episodes.seasonNumber, 0)
					];
					if (request.options.isAutomatic) conditions.push(eq(episodes.monitored, true));
					const missingEpisodes = await db.query.episodes.findMany({
						where: and(...conditions)
					});
					episodeIds = missingEpisodes.map((episode) => episode.id);
				}
			}

			let episodeScope: TargetIdentityInfo['episodeScope'];
			if (episodeIds && episodeIds.length > 0) {
				const scoped = await db.query.episodes.findMany({
					where: and(eq(episodes.seriesId, seriesId!), inArray(episodes.id, episodeIds))
				});
				episodeScope = scoped.map((episode) => ({
					seasonNumber: episode.seasonNumber,
					episodeNumber: episode.episodeNumber
				}));

				// Single-episode targets must carry their season: IdentityStage
				// skips the season check when targetInfo.seasonNumber is null, so
				// without this a release for the same episode number in another
				// season (Show.S02E05 for target S01E05) would pass identity.
				if (target.type === 'episode' && seasonNumber === undefined && scoped.length === 1) {
					seasonNumber = scoped[0].seasonNumber;
				}
			}

			targetInfo = {
				mediaType: 'tv',
				titles: await this.resolveTargetTitles(
					'series',
					seriesId!,
					show!.title,
					show!.originalTitle
				),
				year: show!.year ?? undefined,
				tmdbId: show!.tmdbId,
				tvdbId: show!.tvdbId ?? null,
				imdbId: show!.imdbId ?? null,
				seasonNumber,
				episodeScope
			};
		}

		let rootFolderPath: string | undefined;
		if (rootFolderId) {
			const folder = await db.query.rootFolders.findFirst({
				where: eq(rootFolders.id, rootFolderId)
			});
			rootFolderPath = folder?.path ?? undefined;
		}

		const profile = profileId
			? ((await qualityFilter.getProfile(profileId)) ??
				(await qualityFilter.getDefaultScoringProfile()))
			: await qualityFilter.getDefaultScoringProfile();

		return {
			movieId,
			seriesId,
			episodeIds,
			seasonNumber,
			mediaType,
			profile,
			rootFolderPath,
			mediaPath,
			seriesPath: mediaType === 'tv' ? mediaPath : undefined,
			desiredQualities: movieDesiredQualities,
			targetInfo
		};
	}

	/** Canonical title + original title + curated alternates, deduplicated. */
	private async resolveTargetTitles(
		mediaType: 'movie' | 'series',
		mediaId: string,
		canonicalTitle: string,
		originalTitle?: string | null
	): Promise<string[]> {
		const titles = [canonicalTitle];
		const seen = new Set([normalizeIdentityTitle(canonicalTitle)]);

		const push = (title: string | null | undefined) => {
			if (!title) return;
			const normalized = normalizeIdentityTitle(title);
			if (normalized.length === 0 || seen.has(normalized)) return;
			seen.add(normalized);
			titles.push(title);
		};

		push(originalTitle);
		const alternates = await db.query.alternateTitles.findMany({
			where: and(eq(alternateTitles.mediaType, mediaType), eq(alternateTitles.mediaId, mediaId))
		});
		for (const alternate of alternates) push(alternate.title);

		return titles;
	}

	private async getExistingFiles(request: GrabRequest): Promise<ExistingFile[]> {
		const { target } = request;

		if (target.type === 'movie') {
			const files = await db.query.movieFiles.findMany({
				where: eq(movieFiles.movieId, target.movieId)
			});
			return files.map((f) => ({
				id: f.id,
				relativePath: f.relativePath,
				sceneName: f.sceneName,
				size: f.size,
				quality: f.quality as ExistingFile['quality'],
				releaseGroup: f.releaseGroup
			}));
		}

		const seriesId = 'seriesId' in target ? target.seriesId : undefined;
		if (!seriesId) return [];

		const files = await db.query.episodeFiles.findMany({
			where: eq(episodeFiles.seriesId, seriesId)
		});

		if (target.type === 'episode') {
			return files
				.filter((f) => f.episodeIds?.includes(target.episodeId))
				.map((f) => ({
					id: f.id,
					relativePath: f.relativePath,
					sceneName: f.sceneName,
					size: f.size,
					quality: f.quality as ExistingFile['quality'],
					releaseGroup: f.releaseGroup,
					episodeIds: f.episodeIds
				}));
		}

		if (target.type === 'season' || target.type === 'series') {
			const episodeIdSet = new Set(target.episodeIds);
			return files
				.filter((f) => f.episodeIds?.some((id) => episodeIdSet.has(id)))
				.map((f) => ({
					id: f.id,
					relativePath: f.relativePath,
					sceneName: f.sceneName,
					size: f.size,
					quality: f.quality as ExistingFile['quality'],
					releaseGroup: f.releaseGroup,
					episodeIds: f.episodeIds
				}));
		}

		return files.map((f) => ({
			id: f.id,
			relativePath: f.relativePath,
			sceneName: f.sceneName,
			size: f.size,
			quality: f.quality as ExistingFile['quality'],
			releaseGroup: f.releaseGroup,
			episodeIds: f.episodeIds
		}));
	}

	private async routeByProtocol(
		request: GrabRequest,
		resolved: ResolvedContext
	): Promise<HandlerResult> {
		const protocol = request.release.protocol;
		const requestedAcquisition = request.options.acquisitionProtocol;

		if (requestedAcquisition === 'debrid' && protocol !== 'torrent') {
			return {
				success: false,
				error: 'Debrid acquisition requires a torrent release'
			};
		}

		if (protocol === 'torrent') {
			const acquisitionProtocol =
				requestedAcquisition === 'default'
					? getDefaultAcquisitionProtocol()
					: (requestedAcquisition ??
						(request.options.isAutomatic ? getDefaultAcquisitionProtocol() : 'torrent'));

			if (acquisitionProtocol === 'debrid') {
				return new DebridHandler().handle(request, resolved);
			}
		}

		switch (protocol) {
			case 'torrent': {
				const handler = new TorrentHandler();
				return handler.handle(request, resolved);
			}
			case 'usenet': {
				if (request.options.streamUsenet) {
					const handler = new NzbStreamingHandler();
					return handler.handle(request, resolved);
				}
				const handler = new UsenetHandler();
				return handler.handle(request, resolved);
			}
			case 'streaming': {
				const handler = new StreamingHandler();
				return handler.handle(request, resolved);
			}
			default:
				logger.error(
					{ protocol, title: request.release.title },
					'Unknown or missing protocol in grab request'
				);
				return {
					success: false,
					error: `Unknown protocol: ${protocol ?? 'undefined'}`
				};
		}
	}

	private async persistRejectedRelease(
		release: GrabRequest['release'],
		resolved: ResolvedContext,
		decision: import('./grab-types.js').GrabResult['decision']
	): Promise<void> {
		// Resolve tmdbId from the linked movie or series
		let tmdbId: number | undefined;
		let mediaTitle: string | undefined;
		if (resolved.movieId) {
			const movie = await db.query.movies.findFirst({ where: eq(movies.id, resolved.movieId) });
			tmdbId = movie?.tmdbId ?? undefined;
			mediaTitle = movie?.title ?? undefined;
		} else if (resolved.seriesId) {
			const show = await db.query.series.findFirst({ where: eq(series.id, resolved.seriesId) });
			tmdbId = show?.tmdbId ?? undefined;
			mediaTitle = show?.title ?? undefined;
		}

		const rejectingStage = decision?.audit?.stages?.find(
			(s) => !s.skipped && s.result && !s.result.accepted
		);

		// Build structured rejection checks from all evaluated stages
		const rejectionReasons = decision?.audit?.stages
			?.filter((s) => !s.skipped && s.result != null)
			.map((s) => ({
				type: s.name,
				rule: s.result?.reason ?? s.name,
				passed: s.result?.accepted ?? true,
				detail: s.result?.details ? JSON.stringify(s.result.details) : undefined
			}));

		// Derive primary_reason category from the rejection type
		const primaryReason = (() => {
			switch (decision?.rejectionType) {
				case 'missing_required_format':
				case 'banned':
					return 'required_format_mismatch';
				case 'below_minimum':
				case 'not_upgrade':
				case 'upgrades_disabled':
				case 'size_rejected':
					return 'quality_profile_mismatch';
				case 'pending_delay':
					return 'delay_profile_pending';
				default:
					return decision?.rejectionType ?? 'other';
			}
		})();

		await db.insert(rejectedReleases).values({
			id: randomUUID(),
			correlationId: getRequestId() ?? randomUUID(),
			releaseTitle: release.title,
			indexerName: release.indexerName ?? undefined,
			protocol: release.protocol ?? undefined,
			tmdbId: tmdbId ?? null,
			mediaType: resolved.mediaType,
			mediaTitle: mediaTitle ?? undefined,
			rejectionReasons:
				rejectionReasons && rejectionReasons.length > 0 ? rejectionReasons : undefined,
			primaryReason,
			ruleFired: rejectingStage?.result?.reason ?? decision?.reason ?? undefined,
			qualityProfileName: resolved.profile?.name ?? undefined,
			releaseSize: release.size ?? undefined,
			releaseGroup: release.releaseGroup ?? undefined,
			// Grab fields for future override
			downloadUrl: release.downloadUrl ?? undefined,
			magnetUrl: release.magnetUrl ?? undefined,
			infoHash: release.infoHash ?? undefined,
			indexerGuid: release.guid ?? undefined,
			indexerId: release.indexerId ?? undefined,
			rejectedAt: new Date().toISOString(),
			status: 'rejected'
		});
	}

	/**
	 * Records a grab attempt that reached routeByProtocol but failed there
	 * (e.g. "No enabled torrent download client configured") as a real
	 * download_history row.
	 */
	private async persistFailedGrab(
		release: GrabRequest['release'],
		resolved: ResolvedContext,
		errorMessage: string | undefined
	): Promise<void> {
		const now = new Date().toISOString();
		await db.insert(downloadHistory).values({
			// No real download ID exists - the attempt never reached a client,
			// so there's nothing to assign one from.
			downloadId: null,
			infoHash: release.infoHash,
			title: release.title,
			indexerId: release.indexerId,
			indexerName: release.indexerName,
			protocol: release.protocol,
			movieId: resolved.movieId,
			seriesId: resolved.seriesId,
			episodeIds: resolved.episodeIds,
			seasonNumber: resolved.seasonNumber,
			status: 'failed',
			statusReason: errorMessage ?? 'Grab failed',
			size: release.size,
			releaseGroup: release.releaseGroup,
			grabbedAt: now,
			completedAt: now
		});
	}
}

export const grabService = GrabServiceImpl.getInstance();
export { GrabServiceImpl as GrabService };

import { stat } from 'node:fs/promises';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, episodes, movies, rootFolders, series } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { isImportedQueueStatus } from '#lib/types/queue.js';
import { NamingService } from '#lib/server/library/naming/NamingService.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { getDownloadClientManager } from '../DownloadClientManager';
import { DebridImportFinalizer } from './DebridImportFinalizer';
import { mediaInfoService } from '#lib/server/library/media-info.js';
import {
	recalculateMovieShortfall,
	recalculateSeriesShortfall
} from '#lib/server/languages/language-shortfall.js';

/** Best-effort local probe; empty mediaInfo when ffprobe cannot answer. */
async function probeLocalMediaInfo(path: string): Promise<Record<string, unknown>> {
	try {
		return (await mediaInfoService.extractMediaInfo(path)) ?? {};
	} catch {
		return {};
	}
}
import type { DebridImportFinalizerInput } from './DebridImportFinalizer';
import { getDownloadMonitor } from '../monitoring/DownloadMonitorService';
import { DebridFileMaterializer } from './DebridFileMaterializer';
import { ReadyProviderFileMapper } from './ReadyProviderFileMapper';
import type { DebridAdapter, ProviderItem } from './debrid-adapter';
import { debridErrorMessage, redactDebridDiagnostic } from './diagnostics';

const logger = createChildLogger({ logDomain: 'imports' as const });
const POLL_INTERVAL_MS = 15_000;
const CLAIM_LEASE_MS = 5 * 60_000;
const TERMINAL = ['imported', 'seeding-imported', 'failed', 'removed'] as const;
const NOT_CLAIMABLE = [...TERMINAL, 'postprocessing', 'importing'] as const;

type QueueRow = typeof downloadQueue.$inferSelect;
type ExistingReceipt = {
	finalPath: string;
	sizeBytes: number;
	createdByAttempt: false;
	replacedExisting: false;
};

export class DebridPollService implements BackgroundService {
	readonly name = 'DebridPoll';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private running = false;
	private ticking = false;
	private reconciledFailedHistory = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private controller: AbortController | null = null;
	private readonly manager = getDownloadClientManager();
	private readonly mapper = new ReadyProviderFileMapper({
		naming: new NamingService(namingSettingsService.getConfigSync())
	});
	private readonly finalizer = new DebridImportFinalizer();

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this._status = 'ready';
		this.controller = new AbortController();
		this.schedule(0);
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.controller?.abort();
		this.controller = null;
		while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 5));
		this._status = 'pending';
	}

	async tickOnce(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			if (!this.reconciledFailedHistory) {
				await this.reconcileFailedHistory();
				this.reconciledFailedHistory = true;
			}
			const rows = await db
				.select()
				.from(downloadQueue)
				.where(
					and(
						eq(downloadQueue.protocol, 'debrid'),
						notInArray(downloadQueue.status, [...TERMINAL, 'importing'])
					)
				)
				.all();
			for (const row of rows) {
				if (row.status === 'postprocessing' && !this.stale(row.lastAttemptAt)) continue;
				try {
					await this.process(row);
				} catch (error) {
					logger.warn(
						{ queueItemId: row.id, error: debridErrorMessage(error, 'Polling failed') },
						'Debrid queue item remains recoverable after polling failure'
					);
				}
			}
		} finally {
			this.ticking = false;
		}
	}

	private schedule(delay: number): void {
		if (!this.running) return;
		this.timer = setTimeout(() => {
			void this.tickOnce().finally(() => this.running && this.schedule(POLL_INTERVAL_MS));
		}, delay);
	}

	private async process(row: QueueRow): Promise<void> {
		if (isImportedQueueStatus(row.status) || !(await this.claim(row))) return;
		const [current] = await db
			.select()
			.from(downloadQueue)
			.where(eq(downloadQueue.id, row.id))
			.limit(1);
		if (!current || isImportedQueueStatus(current.status)) return;

		const selected = await this.manager.getDebridClientForAcquisition(
			current.downloadClientId ?? undefined
		);
		if (!selected) {
			await this.retry(
				current.id,
				row.status,
				'Debrid client is unavailable. Re-enable the client and try again.'
			);
			return;
		}

		let providerItem: ProviderItem;
		try {
			providerItem = await selected.adapter.inspect(current.downloadId);
		} catch (error) {
			const message = debridErrorMessage(error, 'Provider inspect failed');
			if (/not found|item not found|no such/i.test(message)) {
				await this.fail(current.id, `Provider item is missing: ${message}`);
			} else {
				await this.retry(current.id, row.status, `Provider inspect failed: ${message}`);
			}
			return;
		}

		switch (providerItem.readiness) {
			case 'terminal':
				await this.fail(
					current.id,
					`Provider item is in a terminal state: ${providerItem.terminalReason ?? 'unknown'}`
				);
				return;
			case 'awaiting_selection':
				await this.retry(current.id, row.status, 'Provider item awaiting selection');
				return;
			case 'pending':
				await this.retry(current.id, 'downloading', 'Provider item is downloading');
				return;
			case 'ready':
				await this.importReady(
					current,
					providerItem,
					selected.adapter,
					selected.client.removeAfterImport ?? false
				);
		}
	}

	private async claim(row: QueueRow): Promise<boolean> {
		const now = Date.now();
		const previous = row.lastAttemptAt ? Date.parse(row.lastAttemptAt) : 0;
		const claimedAt = new Date(Math.max(now, Number.isFinite(previous) ? previous + 1 : now));
		const previousMatches = row.lastAttemptAt
			? eq(downloadQueue.lastAttemptAt, row.lastAttemptAt)
			: isNull(downloadQueue.lastAttemptAt);
		const result = await db
			.update(downloadQueue)
			.set({ status: 'postprocessing', lastAttemptAt: claimedAt.toISOString() })
			.where(
				and(
					eq(downloadQueue.id, row.id),
					row.status === 'postprocessing'
						? and(eq(downloadQueue.status, 'postprocessing'), previousMatches)
						: notInArray(downloadQueue.status, [...NOT_CLAIMABLE])
				)
			)
			.run();
		return result.changes > 0;
	}

	private stale(lastAttemptAt: string | null): boolean {
		if (!lastAttemptAt) return true;
		const timestamp = Date.parse(lastAttemptAt);
		return !Number.isFinite(timestamp) || Date.now() - timestamp >= CLAIM_LEASE_MS;
	}

	/**
	 * Ordered audio languages for the item's effective language profile
	 * (original first when preferOriginal) — drives the debrid movie
	 * file-choice tiebreaker. Best-effort: empty when unresolvable.
	 */
	private async resolvePreferredAudioLanguages(
		media: { type: 'movie'; movie: { id: string } } | { type: 'series' } | undefined
	): Promise<string[]> {
		if (!media || media.type !== 'movie' || !media.movie.id) return [];
		try {
			const { resolveAudioPreferenceForItem } =
				await import('#lib/server/languages/audio-preference-resolver.js');
			const preference = await resolveAudioPreferenceForItem('movie', media.movie.id);
			const ordered = [
				...(preference.preferOriginal && preference.originalLanguage
					? [preference.originalLanguage]
					: []),
				...preference.languages
			];
			return ordered;
		} catch {
			return [];
		}
	}

	private async importReady(
		row: QueueRow,
		providerItem: ProviderItem,
		adapter: DebridAdapter,
		removeAfterImport: boolean
	): Promise<void> {
		const context = await this.mediaContext(row);
		if (!context) {
			await this.fail(row.id, 'Queue item has no resolvable media context');
			return;
		}

		let mapping;
		try {
			mapping = await this.mapper.map({
				providerItem,
				context: {
					queueItem: {
						title: row.title,
						movieId: row.movieId ?? undefined,
						seriesId: row.seriesId ?? undefined,
						episodeIds: row.episodeIds ?? undefined,
						seasonNumber: row.seasonNumber ?? undefined
					},
					media: context.media,
					library: { rootPath: context.rootPath }
				},
				preferredAudioLanguages: await this.resolvePreferredAudioLanguages(context.media)
			});
		} catch (error) {
			await this.fail(
				row.id,
				`Provider file mapping failed: ${debridErrorMessage(error, 'Mapping failed')}`
			);
			return;
		}

		const materializer = new DebridFileMaterializer({
			adapter,
			connectTimeoutMs: 10_000,
			readTimeoutMs: 30_000
		});
		const files: DebridImportFinalizerInput['files'] = [];
		for (const entry of mapping.files) {
			const expectedSize =
				typeof entry.metadata?.sizeBytes === 'number' ? entry.metadata.sizeBytes : 0;
			try {
				const receipt = await this.materialize(
					materializer,
					entry.providerFileRef.providerItemId,
					entry.providerFileRef.providerFileId,
					expectedSize,
					entry.plan,
					context.rootPath
				);
				files.push({
					plan: entry.plan,
					receipt: {
						finalPath: receipt.finalPath,
						sizeBytes: receipt.sizeBytes,
						createdByAttempt: receipt.createdByAttempt,
						replacedExisting: receipt.replacedExisting
					},
					metadata: {
						sourcePath: '',
						sceneName: row.title,
						releaseGroup: row.releaseGroup ?? '',
						seasonNumber: entry.media.seasonNumber ?? row.seasonNumber ?? undefined,
						episodeIds: entry.media.episodeIds ?? row.episodeIds ?? undefined,
						quality: (row.quality ?? undefined) as {
							resolution?: string;
							source?: string;
							codec?: string;
							hdr?: string;
						},
						// The materialized file is on local disk — probe it here
						// instead of persisting empty mediaInfo (phase D fix).
						mediaInfo: await probeLocalMediaInfo(receipt.finalPath)
					}
				});
			} catch (error) {
				const interrupted =
					error instanceof Error &&
					(error.name === 'AbortError' || /abort|cancel/i.test(error.message));
				await this.retry(
					row.id,
					'postprocessing',
					interrupted
						? 'Materialization interrupted by shutdown'
						: `Materialization failed: ${debridErrorMessage(error, 'Transfer failed')}`
				);
				return;
			}
		}

		try {
			const result = await this.finalizer.finalize({
				queueItemId: row.id,
				mediaType: context.mediaType,
				movieId: context.mediaType === 'movie' ? (row.movieId ?? undefined) : undefined,
				seriesId: context.mediaType === 'series' ? (row.seriesId ?? undefined) : undefined,
				files
			});
			if (!result.success) throw new Error('Finalization reported failure');

			// Audio-language verification (phase D): now that probed mediaInfo
			// landed with the files, maintain the shortfall flag.
			if (context.mediaType === 'movie' && row.movieId) {
				await recalculateMovieShortfall(row.movieId);
			} else if (context.mediaType === 'series' && row.seriesId) {
				await recalculateSeriesShortfall(row.seriesId);
			}
		} catch (error) {
			await this.retry(
				row.id,
				'postprocessing',
				`Finalization failed: ${debridErrorMessage(error, 'Finalization failed')}`
			);
			return;
		}

		if (removeAfterImport) {
			try {
				await adapter.delete(row.downloadId);
			} catch (error) {
				const warning = `Provider cleanup failed: ${debridErrorMessage(error, 'Delete failed')}`;
				await db
					.update(downloadQueue)
					.set({ errorMessage: redactDebridDiagnostic(warning) })
					.where(eq(downloadQueue.id, row.id))
					.run();
				logger.warn(
					{ queueItemId: row.id, error: warning },
					'Provider cleanup failed after import'
				);
			}
		}
	}

	private async materialize(
		materializer: DebridFileMaterializer,
		providerItemId: string,
		providerFileId: string,
		expectedSize: number,
		plan: { fileName: string; relativePath: string; finalPath: string },
		rootPath: string
	): Promise<Awaited<ReturnType<DebridFileMaterializer['materialize']>> | ExistingReceipt> {
		try {
			const existing = await stat(plan.finalPath);
			if (existing.isFile()) {
				if (existing.size !== expectedSize) throw new Error('Existing file size does not match');
				return {
					finalPath: plan.finalPath,
					sizeBytes: existing.size,
					createdByAttempt: false,
					replacedExisting: false
				};
			}
		} catch (error) {
			if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
		}
		return materializer.materialize({
			providerItemId,
			providerFileId,
			providerSizeBytes: expectedSize,
			plan,
			rootPath,
			signal: this.controller?.signal
		});
	}

	private async mediaContext(row: QueueRow) {
		if (row.movieId) {
			const [movie] = await db.select().from(movies).where(eq(movies.id, row.movieId)).limit(1);
			if (!movie?.rootFolderId) return;
			const [root] = await db
				.select()
				.from(rootFolders)
				.where(eq(rootFolders.id, movie.rootFolderId))
				.limit(1);
			if (!root) return;
			return {
				mediaType: 'movie' as const,
				rootPath: root.path,
				media: {
					type: 'movie' as const,
					movie: {
						id: movie.id,
						title: movie.title,
						originalTitle: movie.originalTitle ?? null,
						year: movie.year ?? null,
						tmdbId: movie.tmdbId,
						imdbId: movie.imdbId ?? null,
						collectionName: movie.collectionName ?? null,
						path: movie.path
					}
				}
			};
		}
		if (!row.seriesId) return;
		const [show] = await db.select().from(series).where(eq(series.id, row.seriesId)).limit(1);
		if (!show?.rootFolderId) return;
		const [root] = await db
			.select()
			.from(rootFolders)
			.where(eq(rootFolders.id, show.rootFolderId))
			.limit(1);
		if (!root) return;
		const episodeRows = await db
			.select()
			.from(episodes)
			.where(eq(episodes.seriesId, row.seriesId))
			.all();
		return {
			mediaType: 'series' as const,
			rootPath: root.path,
			media: {
				type: 'series' as const,
				series: {
					id: show.id,
					title: show.title,
					originalTitle: show.originalTitle ?? null,
					year: show.year ?? null,
					tmdbId: show.tmdbId ?? null,
					tvdbId: show.tvdbId ?? null,
					imdbId: show.imdbId ?? null,
					path: show.path,
					seriesType: show.seriesType ?? null,
					seasonFolder: show.seasonFolder ?? null
				},
				episodes: episodeRows.map((episode) => ({
					id: episode.id,
					seasonNumber: episode.seasonNumber,
					episodeNumber: episode.episodeNumber,
					title: episode.title ?? null,
					absoluteEpisodeNumber: episode.absoluteEpisodeNumber ?? null,
					airDate: episode.airDate ?? null
				}))
			}
		};
	}

	private async retry(id: string, priorStatus: string, message: string): Promise<void> {
		await db
			.update(downloadQueue)
			.set({
				status: priorStatus === 'downloading' ? 'downloading' : 'queued',
				errorMessage: redactDebridDiagnostic(message),
				lastAttemptAt: new Date().toISOString()
			})
			.where(eq(downloadQueue.id, id))
			.run();
	}

	private async reconcileFailedHistory(): Promise<void> {
		const failedRows = await db
			.select({ id: downloadQueue.id, errorMessage: downloadQueue.errorMessage })
			.from(downloadQueue)
			.where(and(eq(downloadQueue.protocol, 'debrid'), eq(downloadQueue.status, 'failed')))
			.all();
		for (const row of failedRows) {
			await getDownloadMonitor().markFailed(row.id, row.errorMessage ?? 'Debrid download failed');
		}
	}

	private async fail(id: string, message: string): Promise<void> {
		const safeMessage = redactDebridDiagnostic(message);
		await getDownloadMonitor().markFailed(id, safeMessage);
		logger.warn({ queueItemId: id, error: safeMessage }, 'Debrid queue item failed');
	}
}

let instance: DebridPollService | null = null;

export function getDebridPollService(): DebridPollService {
	return (instance ??= new DebridPollService());
}

export function resetDebridPollService(): void {
	instance = null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

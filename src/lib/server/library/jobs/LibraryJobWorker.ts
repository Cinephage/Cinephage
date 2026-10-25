import { EventEmitter } from 'events';
import { createChildLogger } from '#lib/logging/index.js';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { LibraryJobService, libraryJobService } from './LibraryJobService.js';
import type { LibraryJobType } from './types.js';
import { diskScanService } from '#lib/server/library/disk-scan.js';
import { librarySchedulerService } from '#lib/server/library/library-scheduler.js';
import { mediaMatcherService } from '#lib/server/library/media-matcher.js';
import type { MatchResult } from '#lib/server/library/media-matcher.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import type {
	ExecuteManualImportRequest,
	ExecuteManualImportResult
} from '../manual-import-service.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

export interface ScanResultLike {
	success: boolean;
	filesScanned?: number;
	filesAdded?: number;
	filesUpdated?: number;
	filesRemoved?: number;
	unmatchedFiles?: number;
	error?: string;
}

export interface WorkerDeps {
	name?: string;
	/** Restrict this worker to only claim these job types. Undefined = any
	 * type (the primary worker's default, matching pre-pool behavior). */
	jobTypes?: LibraryJobType[];
	jobService?: LibraryJobService;
	scanRootFolder?: (rootFolderId: string) => Promise<ScanResultLike>;
	scanAll?: () => Promise<ScanResultLike[]>;
	matchUnmatchedByRootFolder?: (
		rootFolderId: string,
		limit?: number,
		afterId?: string | null
	) => Promise<{ results: MatchResult[]; hasMore: boolean; nextCursor: string | null }>;
	executeManualImport?: (request: ExecuteManualImportRequest) => Promise<ExecuteManualImportResult>;
}

export class LibraryJobWorker extends EventEmitter implements BackgroundService {
	readonly name: string;
	private readonly jobTypes?: LibraryJobType[];
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private running = false;
	private loopTimer: ReturnType<typeof setTimeout> | null = null;
	private jobService: LibraryJobService;
	private scanRootFolder: (rootFolderId: string) => Promise<ScanResultLike>;
	private scanAll: () => Promise<ScanResultLike[]>;
	private matchUnmatchedByRootFolder: (
		rootFolderId: string,
		limit?: number,
		afterId?: string | null
	) => Promise<{ results: MatchResult[]; hasMore: boolean; nextCursor: string | null }>;
	private executeManualImport: (
		request: ExecuteManualImportRequest
	) => Promise<ExecuteManualImportResult>;

	constructor(deps: WorkerDeps = {}) {
		super();
		this.name = deps.name ?? 'LibraryJobWorker';
		this.jobTypes = deps.jobTypes;
		this.jobService = deps.jobService ?? libraryJobService;
		this.scanRootFolder =
			deps.scanRootFolder ??
			((rootFolderId: string) => librarySchedulerService.runFolderScan(rootFolderId));
		this.scanAll = deps.scanAll ?? (() => librarySchedulerService.runFullScan());
		this.matchUnmatchedByRootFolder =
			deps.matchUnmatchedByRootFolder ??
			((rootFolderId, limit, afterId) =>
				mediaMatcherService.processUnmatchedByRootFolder(rootFolderId, limit, afterId));
		this.executeManualImport =
			deps.executeManualImport ??
			((request) =>
				import('../manual-import-service.js').then((m) =>
					m.manualImportService.executeImport(request)
				));
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	start(): void {
		this._status = 'starting';
		this.jobService.recoverInterruptedJobs();

		setImmediate(() => {
			this.running = true;
			this._status = 'ready';
			this.processLoop().catch((err) => {
				this._error = err instanceof Error ? err : new Error(String(err));
				this._status = 'error';
				logger.error({ err: this._error }, '[LibraryJobWorker] Loop failed');
			});
		});
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.loopTimer) {
			clearTimeout(this.loopTimer);
			this.loopTimer = null;
		}
		this._status = 'pending';
	}

	async processOne(): Promise<boolean> {
		// Atomic claim: closes the race two concurrent worker loops would
		// otherwise hit between finding a queued job and marking it running.
		const queuedJob = this.jobService.claimNextJob(this.jobTypes);
		if (!queuedJob) return false;

		// The claim (select + guarded update) runs as one synchronous
		// transaction with no window for an external request to touch the
		// row in between, so cancelRequested here can only mean it was set
		// while the job was still queued.
		if (queuedJob.cancelRequested) {
			await this.jobService.markCancelled(queuedJob.id);
			return true;
		}

		// diskScanService.setCancelCheck is process-wide mutable state; only
		// scan-type jobs (below) read it, and only one worker instance ever
		// runs those (see LibraryJobWorker pool registration), so scoping the
		// set/reset to just those branches keeps this safe even with multiple
		// worker instances running concurrently on other job types.
		const usesDiskScanCancelCheck =
			queuedJob.type === 'scan_root_folder' || queuedJob.type === 'scan_all_root_folders';
		if (usesDiskScanCancelCheck) {
			diskScanService.setCancelCheck(async () => {
				const job = await this.jobService.getJob(queuedJob.id);
				return job?.cancelRequested === true;
			});
		}

		try {
			if (queuedJob.type === 'scan_root_folder') {
				if (!queuedJob.rootFolderId) throw new Error('scan_root_folder job missing rootFolderId');
				const result = await this.scanRootFolder(queuedJob.rootFolderId);
				await this.jobService.markCompleted(queuedJob.id, {
					filesFound: result.filesScanned,
					filesProcessed: result.filesScanned,
					filesAdded: result.filesAdded,
					filesUpdated: result.filesUpdated,
					filesRemoved: result.filesRemoved,
					unmatchedCount: result.unmatchedFiles,
					phase: 'done'
				});
				await this.jobService.enqueueJob({
					type: 'match_unmatched',
					rootFolderId: queuedJob.rootFolderId,
					dedupeKey: `match_unmatched:${queuedJob.rootFolderId}`,
					metadata: { rootFolderId: queuedJob.rootFolderId }
				});
			} else if (queuedJob.type === 'match_unmatched') {
				if (!queuedJob.rootFolderId) throw new Error('match_unmatched job missing rootFolderId');
				// Keyset cursor: immune to rows disappearing mid-pass (matches delete
				// their unmatched row). Absolute offsets skipped half the files (#513).
				let cursor: string | null = null;
				let hasMore = true;
				let _matched = 0;
				let total = 0;
				while (hasMore) {
					const page = await this.matchUnmatchedByRootFolder(queuedJob.rootFolderId, 50, cursor);
					_matched += page.results.filter((r) => r.matched).length;
					total += page.results.length;
					hasMore = page.hasMore;
					cursor = page.nextCursor;

					const reloaded = await this.jobService.getJob(queuedJob.id);
					if (reloaded?.cancelRequested) break;

					// Yield between pages so the event loop stays responsive.
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				await this.jobService.markCompleted(queuedJob.id, {
					phase: 'done',
					progressCurrent: total,
					progressTotal: total
				});
			} else if (queuedJob.type === 'manual_import') {
				const request = (queuedJob.metadata as { request?: ExecuteManualImportRequest } | null)
					?.request;
				if (!request) {
					throw new Error('manual_import job missing request metadata');
				}
				await this.jobService.markProgress(queuedJob.id, {
					phase: 'importing',
					progressTotal: 1,
					progressCurrent: 0
				});
				const result = await this.executeManualImport(request);
				await this.jobService.markCompleted(queuedJob.id, {
					phase: 'done',
					progressCurrent: 1,
					progressTotal: 1,
					filesAdded: result.importedCount,
					metadata: {
						result: {
							libraryId: result.libraryId,
							mediaType: result.mediaType,
							tmdbId: result.tmdbId,
							importedPaths: result.importedPaths
						}
					}
				});
				// Mirror the sync import endpoint: downstream caches (rename preview,
				// library views) key off this event.
				libraryMediaEvents.emitLibraryDataChanged({
					source: request.mediaType === 'movie' ? 'movie' : 'series',
					reason: 'manual-import',
					tmdbId: result.tmdbId ?? undefined
				});
			} else if (queuedJob.type === 'scan_all_root_folders') {
				const results = await this.scanAll();
				const failed = results.filter((r) => !r.success);
				if (failed.length > 0) {
					const messages = failed.map((f) => f.error || 'Unknown error').join('; ');
					throw new Error(messages);
				}
				const totals = results.reduce(
					(acc, r) => ({
						filesFound: acc.filesFound + (r.filesScanned || 0),
						filesProcessed: acc.filesProcessed + (r.filesScanned || 0),
						filesAdded: acc.filesAdded + (r.filesAdded || 0),
						filesUpdated: acc.filesUpdated + (r.filesUpdated || 0),
						filesRemoved: acc.filesRemoved + (r.filesRemoved || 0),
						unmatchedCount: acc.unmatchedCount + (r.unmatchedFiles || 0)
					}),
					{
						filesFound: 0,
						filesProcessed: 0,
						filesAdded: 0,
						filesUpdated: 0,
						filesRemoved: 0,
						unmatchedCount: 0
					}
				);
				this.jobService.markCompleted(queuedJob.id, { ...totals, phase: 'done' });
			} else {
				// Declared job types without a handler must never sit in `running`
				// forever — fail them visibly so retry/cancel stays available.
				await this.jobService.markFailed(
					queuedJob.id,
					`Unsupported library job type: ${queuedJob.type}`
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.jobService.markFailed(queuedJob.id, message);
		} finally {
			if (usesDiskScanCancelCheck) {
				diskScanService.setCancelCheck(null);
			}
		}

		return true;
	}

	private async processLoop(): Promise<void> {
		while (this.running) {
			// A claim/dispatch error must never kill the loop: a dead worker leaves
			// every future job queued forever, which presents to users as "scan
			// completes instantly but does nothing" (#513). Back off and retry.
			let processed: boolean;
			try {
				processed = await this.processOne();
			} catch (err) {
				logger.error(
					{ err: err instanceof Error ? err : new Error(String(err)) },
					'[LibraryJobWorker] Job dispatch failed; retrying'
				);
				await new Promise<void>((resolve) => {
					this.loopTimer = setTimeout(resolve, 5000);
				});
				continue;
			}
			if (!processed) {
				await new Promise<void>((resolve) => {
					this.loopTimer = setTimeout(resolve, 1000);
				});
			} else {
				// Yield before picking up the next job so the event loop can
				// serve HTTP requests and flush logs between jobs.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
	}
}

export const libraryJobWorker = new LibraryJobWorker();

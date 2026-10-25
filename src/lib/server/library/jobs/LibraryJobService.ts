import { db, sqlite } from '#lib/server/db/index.js';
import { libraryJobs, unmatchedFiles } from '#lib/server/db/schema.js';
import { eq, and, or, isNull, asc, desc, inArray, lt, sql } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';
import type { EnqueueLibraryJobInput, LibraryJobStatus, LibraryJobType } from './types.js';

export interface BatchSummary {
	/** parentJobId for a multi-job batch, or the lone job's own id otherwise. */
	key: string;
	total: number;
	completed: number;
	failed: number;
	active: boolean;
	createdAt: string;
	itemName: string | null;
	/** True once every job in the batch has been acknowledged (dismissed
	 * without retrying); the card stops treating it as needing attention. */
	acknowledged: boolean;
}

interface LibraryJobUpdate {
	phase?: string;
	progressCurrent?: number;
	progressTotal?: number;
	filesFound?: number;
	filesProcessed?: number;
	filesAdded?: number;
	filesUpdated?: number;
	filesRemoved?: number;
	unmatchedCount?: number;
	/** Merged into (not replacing) the job's existing metadata JSON. */
	metadata?: Record<string, unknown>;
}

export interface ListJobsFilter {
	type?: LibraryJobType;
	status?: LibraryJobStatus;
	parentJobId?: string;
	limit?: number;
}

export class LibraryJobService {
	private static instance: LibraryJobService;

	private constructor() {}

	static getInstance(): LibraryJobService {
		if (!LibraryJobService.instance) {
			LibraryJobService.instance = new LibraryJobService();
		}
		return LibraryJobService.instance;
	}

	enqueueRootFolderScan(rootFolderId: string) {
		return this.enqueueJob({
			type: 'scan_root_folder',
			rootFolderId,
			dedupeKey: `scan_root_folder:${rootFolderId}`
		});
	}

	enqueueFullScan() {
		return this.enqueueJob({
			type: 'scan_all_root_folders',
			dedupeKey: 'scan_all_root_folders'
		});
	}

	/**
	 * Enqueue match_unmatched jobs for every root folder that currently has
	 * unmatched files. Used by the Unmatched page's "process all" action:
	 * matching hundreds of files takes minutes and must not run inline inside
	 * an HTTP request (#513).
	 */
	enqueueMatchUnmatchedForAllFolders(): { folderId: string; jobId: string }[] {
		const folders = db
			.selectDistinct({ rootFolderId: unmatchedFiles.rootFolderId })
			.from(unmatchedFiles)
			.all();

		const enqueued: { folderId: string; jobId: string }[] = [];
		for (const { rootFolderId } of folders) {
			if (!rootFolderId) continue;
			const job = this.enqueueJob({
				type: 'match_unmatched',
				rootFolderId,
				dedupeKey: `match_unmatched:${rootFolderId}`,
				metadata: { rootFolderId }
			});
			enqueued.push({ folderId: rootFolderId, jobId: job.id });
		}
		return enqueued;
	}

	enqueueJob(input: EnqueueLibraryJobInput) {
		if (input.dedupeKey) {
			// A job that has been 'running' for over an hour was almost certainly
			// abandoned by a crash or kill signal. Reset it so it no longer blocks
			// new jobs with the same dedupeKey.
			//
			// 'queued' jobs age out on createdAt for the same reason: a queued row
			// with startedAt=NULL would otherwise block its dedupeKey forever if
			// the worker ever failed to pick it up (#513).
			const staleThreshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();
			const now = new Date().toISOString();
			db.update(libraryJobs)
				.set({
					status: 'failed',
					errorMessage: 'Job timed out (exceeded 1 hour without completion)',
					completedAt: now,
					updatedAt: now
				})
				.where(
					and(
						eq(libraryJobs.dedupeKey, input.dedupeKey),
						inArray(libraryJobs.status, ['running', 'queued']),
						lt(sql`COALESCE(${libraryJobs.startedAt}, ${libraryJobs.createdAt})`, staleThreshold)
					)
				)
				.run();

			const existing = db
				.select()
				.from(libraryJobs)
				.where(
					and(
						eq(libraryJobs.dedupeKey, input.dedupeKey),
						inArray(libraryJobs.status, ['queued', 'running'])
					)
				)
				.get();

			if (existing) return existing;
		}

		const now = new Date().toISOString();
		const job = {
			type: input.type,
			status: 'queued' as const,
			rootFolderId: input.rootFolderId ?? null,
			parentJobId: input.parentJobId ?? null,
			dedupeKey: input.dedupeKey ?? null,
			phase: 'queued',
			progressCurrent: 0,
			progressTotal: null as number | null,
			filesFound: 0,
			filesProcessed: 0,
			filesAdded: 0,
			filesUpdated: 0,
			filesRemoved: 0,
			unmatchedCount: 0,
			errorMessage: null as string | null,
			cancelRequested: false,
			metadata: input.metadata ?? null,
			startedAt: null as string | null,
			completedAt: null as string | null,
			createdAt: now,
			updatedAt: now
		};

		const result = db.insert(libraryJobs).values(job).returning().get();
		if (!result) throw new NotFoundError('LibraryJob', 'insert failed');
		return result;
	}

	getJob(id: string) {
		return db.select().from(libraryJobs).where(eq(libraryJobs.id, id)).get();
	}

	listRecentJobs(limit = 20) {
		return db.select().from(libraryJobs).orderBy(desc(libraryJobs.createdAt)).limit(limit).all();
	}

	/** Generic filtered listing used by the jobs API (type/status/parentJobId). */
	listJobs(filter: ListJobsFilter = {}) {
		const conditions = [
			filter.type ? eq(libraryJobs.type, filter.type) : undefined,
			filter.status ? eq(libraryJobs.status, filter.status) : undefined,
			filter.parentJobId ? eq(libraryJobs.parentJobId, filter.parentJobId) : undefined
		].filter((c): c is NonNullable<typeof c> => c !== undefined);

		const query = db
			.select()
			.from(libraryJobs)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(libraryJobs.createdAt))
			.limit(filter.limit ?? 20);
		return query.all();
	}

	listActiveJobs() {
		return db
			.select()
			.from(libraryJobs)
			.where(inArray(libraryJobs.status, ['queued', 'running']))
			.all();
	}

	/** Every job belonging to one batch (parentJobId), or a lone job whose
	 * own id is the batch key (parentJobId is null). */
	listBatchJobs(batchKey: string) {
		return db
			.select()
			.from(libraryJobs)
			.where(
				or(
					eq(libraryJobs.parentJobId, batchKey),
					and(isNull(libraryJobs.parentJobId), eq(libraryJobs.id, batchKey))
				)
			)
			.all();
	}

	/**
	 * Aggregate manual_import jobs into batches (grouped by parentJobId, or
	 * standalone by id when there is none) without shipping every raw row —
	 * a bulk batch can have thousands of jobs, so the Activity page's summary
	 * card needs true totals, not whatever fits under a row-count limit.
	 * Uses raw SQL because SQLite's GROUP BY has no drizzle query-builder path
	 * for the conditional SUM()s this needs.
	 */
	summarizeManualImportBatches(): BatchSummary[] {
		const groups = sqlite
			.prepare(
				`SELECT
					COALESCE(parent_job_id, id) AS batchKey,
					MIN(created_at) AS createdAt,
					COUNT(*) AS total,
					SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
					SUM(CASE WHEN status IN ('failed', 'cancelled') THEN 1 ELSE 0 END) AS failed,
					SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS activeCount,
					SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END) AS unacknowledgedCount
				FROM library_jobs
				WHERE type = 'manual_import'
				GROUP BY batchKey
				ORDER BY createdAt DESC`
			)
			.all() as Array<{
			batchKey: string;
			createdAt: string;
			total: number;
			completed: number;
			failed: number;
			activeCount: number;
			unacknowledgedCount: number;
		}>;

		const itemNameStmt = sqlite.prepare(
			`SELECT metadata FROM library_jobs
			 WHERE (parent_job_id = ? OR (parent_job_id IS NULL AND id = ?))
			 ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, created_at ASC
			 LIMIT 1`
		);

		return groups.map((g) => {
			const row = itemNameStmt.get(g.batchKey, g.batchKey) as
				{ metadata: string | null } | undefined;
			let itemName: string | null = null;
			if (row?.metadata) {
				try {
					itemName = (JSON.parse(row.metadata) as { groupName?: string }).groupName ?? null;
				} catch {
					itemName = null;
				}
			}
			return {
				key: g.batchKey,
				total: g.total,
				completed: g.completed,
				failed: g.failed,
				active: g.activeCount > 0,
				createdAt: g.createdAt,
				itemName,
				acknowledged: g.unacknowledgedCount === 0
			};
		});
	}

	/** Dismiss a batch without retrying it; marks every job in it
	 * acknowledged so it drops off the "needs attention" list. */
	acknowledgeBatch(batchKey: string): { acknowledged: number } {
		const now = new Date().toISOString();
		const result = db
			.update(libraryJobs)
			.set({ acknowledgedAt: now, updatedAt: now })
			.where(
				and(
					or(
						eq(libraryJobs.parentJobId, batchKey),
						and(isNull(libraryJobs.parentJobId), eq(libraryJobs.id, batchKey))
					),
					isNull(libraryJobs.acknowledgedAt)
				)
			)
			.run();
		return { acknowledged: result.changes };
	}

	/** Existence check for the Activity page's default-tab decision;
	 * avoids a full row fetch just to know whether any import job is active. */
	hasActiveJobs(type?: LibraryJobType): boolean {
		const conditions = [
			inArray(libraryJobs.status, ['queued', 'running']),
			type ? eq(libraryJobs.type, type) : undefined
		].filter((c): c is NonNullable<typeof c> => c !== undefined);

		const row = db
			.select({ id: libraryJobs.id })
			.from(libraryJobs)
			.where(and(...conditions))
			.limit(1)
			.get();
		return row !== undefined;
	}

	/**
	 * Atomically claim the oldest queued job (optionally restricted to
	 * `types`) for a worker to run. Select-then-conditionally-update in one
	 * synchronous transaction closes the race two concurrent worker loops
	 * would otherwise hit between reading a queued row and marking it
	 * running; better-sqlite3 has no `await` between the two statements, so
	 * no other JS code can interleave, but the transaction wrapper keeps that
	 * invariant explicit rather than implicit.
	 */
	claimNextJob(types?: LibraryJobType[]) {
		return db.transaction((tx) => {
			const conditions = [
				eq(libraryJobs.status, 'queued'),
				types && types.length > 0 ? inArray(libraryJobs.type, types) : undefined
			].filter((c): c is NonNullable<typeof c> => c !== undefined);

			const candidate = tx
				.select()
				.from(libraryJobs)
				.where(and(...conditions))
				.orderBy(asc(libraryJobs.createdAt))
				.limit(1)
				.get();
			if (!candidate) return null;

			const now = new Date().toISOString();
			const result = tx
				.update(libraryJobs)
				.set({ status: 'running', phase: 'running', startedAt: now, updatedAt: now })
				.where(and(eq(libraryJobs.id, candidate.id), eq(libraryJobs.status, 'queued')))
				.run();
			if (result.changes === 0) return null; // another worker won the race

			return {
				...candidate,
				status: 'running' as const,
				phase: 'running',
				startedAt: now,
				updatedAt: now
			};
		});
	}

	/** Unconditional transition to running; a test/fixture helper; the
	 * worker itself uses claimNextJob() for the atomic queued->running claim. */
	markRunning(id: string) {
		const job = this.getJob(id);
		if (!job) throw new NotFoundError('LibraryJob', id);

		const now = new Date().toISOString();
		const result = db
			.update(libraryJobs)
			.set({
				status: 'running',
				phase: 'running',
				startedAt: now,
				updatedAt: now
			})
			.where(eq(libraryJobs.id, id))
			.returning()
			.get();
		if (!result) throw new NotFoundError('LibraryJob', id);
		return result;
	}

	/**
	 * Non-terminal in-flight progress update. Terminal transitions use
	 * markCompleted / markFailed.
	 */
	markProgress(
		id: string,
		updates: Pick<LibraryJobUpdate, 'phase' | 'progressCurrent' | 'progressTotal'>
	) {
		const job = this.getJob(id);
		if (!job) throw new NotFoundError('LibraryJob', id);

		const now = new Date().toISOString();
		const result = db
			.update(libraryJobs)
			.set({ ...updates, updatedAt: now })
			.where(eq(libraryJobs.id, id))
			.returning()
			.get();
		if (!result) throw new NotFoundError('LibraryJob', id);
		return result;
	}

	markCompleted(id: string, updates?: LibraryJobUpdate) {
		const job = this.getJob(id);
		if (!job) throw new NotFoundError('LibraryJob', id);

		const now = new Date().toISOString();
		const setValues: Record<string, unknown> = {
			status: 'completed',
			completedAt: now,
			updatedAt: now
		};

		if (updates) {
			for (const [key, value] of Object.entries(updates)) {
				if (value === undefined) continue;
				if (key === 'metadata') {
					setValues.metadata = {
						...((job.metadata as Record<string, unknown> | null) ?? {}),
						...(value as Record<string, unknown>)
					};
					continue;
				}
				setValues[key] = value;
			}
		}

		const result = db
			.update(libraryJobs)
			.set(setValues)
			.where(eq(libraryJobs.id, id))
			.returning()
			.get();
		if (!result) throw new NotFoundError('LibraryJob', id);
		return result;
	}

	/** Transition straight to cancelled regardless of current status; used
	 * when a worker discovers cancelRequested was already set on a job it
	 * just claimed (queued->running), so it never actually executed. */
	markCancelled(id: string) {
		const job = this.getJob(id);
		if (!job) throw new NotFoundError('LibraryJob', id);

		const now = new Date().toISOString();
		const result = db
			.update(libraryJobs)
			.set({
				status: 'cancelled',
				completedAt: now,
				updatedAt: now
			})
			.where(eq(libraryJobs.id, id))
			.returning()
			.get();
		if (!result) throw new NotFoundError('LibraryJob', id);
		return result;
	}

	markFailed(id: string, errorMessage: string) {
		const job = this.getJob(id);
		if (!job) throw new NotFoundError('LibraryJob', id);

		const now = new Date().toISOString();
		const result = db
			.update(libraryJobs)
			.set({
				status: 'failed',
				errorMessage,
				completedAt: now,
				updatedAt: now
			})
			.where(eq(libraryJobs.id, id))
			.returning()
			.get();
		if (!result) throw new NotFoundError('LibraryJob', id);
		return result;
	}

	cancelJob(id: string) {
		const job = this.getJob(id);
		if (!job) throw new NotFoundError('LibraryJob', id);

		if (job.status === 'queued') {
			const now = new Date().toISOString();
			const result = db
				.update(libraryJobs)
				.set({
					status: 'cancelled',
					completedAt: now,
					updatedAt: now
				})
				.where(eq(libraryJobs.id, id))
				.returning()
				.get();
			if (!result) throw new NotFoundError('LibraryJob', id);
			return result;
		}

		if (job.status === 'running') {
			const now = new Date().toISOString();
			const result = db
				.update(libraryJobs)
				.set({
					cancelRequested: true,
					updatedAt: now
				})
				.where(eq(libraryJobs.id, id))
				.returning()
				.get();
			if (!result) throw new NotFoundError('LibraryJob', id);
			return result;
		}

		return job;
	}

	retryJob(id: string) {
		const job = this.getJob(id);
		if (!job) throw new NotFoundError('LibraryJob', id);

		if (job.status !== 'failed' && job.status !== 'cancelled') {
			throw new ValidationError(`Cannot retry job with status ${job.status}`);
		}

		return this.enqueueJob({
			type: job.type as LibraryJobType,
			rootFolderId: job.rootFolderId,
			parentJobId: job.parentJobId,
			dedupeKey: job.dedupeKey,
			metadata: job.metadata as Record<string, unknown> | undefined
		});
	}

	/** Retry every failed/cancelled job in a batch (see listBatchJobs). */
	retryBatch(batchKey: string): { retried: number } {
		const failed = this.listBatchJobs(batchKey).filter(
			(j) => j.status === 'failed' || j.status === 'cancelled'
		);
		for (const job of failed) {
			this.retryJob(job.id);
		}
		return { retried: failed.length };
	}

	/**
	 * Cancel every not-yet-started job in a batch. A still-queued job stops
	 * before it ever runs (cancelJob transitions it straight to cancelled).
	 * A job already running is only flagged (cancelJob's cooperative
	 * cancelRequested path); manual_import never checks that flag mid-run,
	 * so it finishes normally rather than being torn out of a file move or
	 * ffprobe call partway through, which is the safe behavior, not a gap.
	 */
	cancelBatch(batchKey: string): { cancelled: number } {
		const active = this.listBatchJobs(batchKey).filter(
			(j) => j.status === 'queued' || j.status === 'running'
		);
		let cancelled = 0;
		for (const job of active) {
			const result = this.cancelJob(job.id);
			if (result.status === 'cancelled') cancelled++;
		}
		return { cancelled };
	}

	recoverInterruptedJobs() {
		const now = new Date().toISOString();
		const result = db
			.update(libraryJobs)
			.set({
				status: 'failed',
				errorMessage: 'Job interrupted (server restart or crash)',
				completedAt: now,
				updatedAt: now
			})
			.where(eq(libraryJobs.status, 'running'))
			.run();

		return result.changes;
	}
}

export const libraryJobService = LibraryJobService.getInstance();

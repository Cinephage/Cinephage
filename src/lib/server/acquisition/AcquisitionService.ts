import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	acquisitionIntents,
	acquisitionReservations,
	downloadQueue,
	movies
} from '#lib/server/db/schema.js';
import { computeMovieQualitySlot } from './slot-keys.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'AcquisitionService', logDomain: 'downloads' });

export type IntentSource = 'manual' | 'automatic' | 'arr_push' | 'override';
export type IntentStatus = 'active' | 'completed' | 'failed' | 'canceled';

export interface ReleaseIdentity {
	kind: 'info_hash' | 'indexer_guid' | 'provider_hash';
	value: string;
}

export interface CreateIntentInput {
	mediaType: 'movie' | 'tv';
	movieId?: string;
	seriesId?: string;
	seasonNumber?: number;
	/** Expanded concrete episode scope for TV targets. */
	episodeIds?: string[];
	/** 'single' for single-quality movies, the bucket resolution otherwise. */
	qualitySlot: string;
	protocol: string;
	identity?: ReleaseIdentity;
	releaseTitle: string;
	indexerId?: string;
	indexerName?: string;
	/** Pipeline-computed upgrade status at approval time. */
	upgradeStatus?: string;
	decision?: Record<string, unknown>;
	source: IntentSource;
	queueId?: string;
}

export interface IntentConflict {
	intentId: string;
	targetKey: string;
	releaseTitle: string;
	source: string;
	status: string;
	queueId: string | null;
	createdAt: string;
}

export type CreateIntentResult =
	| { ok: true; intentId: string }
	| { ok: false; kind: 'slot_conflict' | 'identity_conflict'; conflict: IntentConflict };

export function movieTargetKey(movieId: string, qualitySlot: string): string {
	return `movie:${movieId}:${qualitySlot}`;
}

export function episodeTargetKey(episodeId: string): string {
	return `episode:${episodeId}`;
}

function targetKeysFor(input: CreateIntentInput): string[] {
	if (input.mediaType === 'movie') {
		return [movieTargetKey(input.movieId!, input.qualitySlot)];
	}
	return (input.episodeIds ?? []).map((episodeId) => episodeTargetKey(episodeId));
}

function isUniqueViolation(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('code' in error)) return false;
	const code = (error as { code?: unknown }).code;
	return (
		code === 'SQLITE_CONSTRAINT_UNIQUE' ||
		(code === 'SQLITE_CONSTRAINT' &&
			/UNIQUE/i.test(String((error as { message?: unknown }).message ?? '')))
	);
}

/**
 * Durable acquisition authority (migration 148).
 *
 * An intent reserves its target slots for the full lifetime of the
 * acquisition — from approval, through download (including stalled,
 * completed-but-unimported, and postprocessing states), until the import
 * finalizer completes it or it fails/cancels. Exclusivity is enforced by
 * the database (partial unique indexes), so it holds across restarts,
 * concurrent tasks, and every entrypoint, unlike the previous in-process
 * locks and queue-status inference.
 *
 * Policy: a slot conflict blocks the grab — manual included — with the
 * conflicting acquisition's details so the caller/UI can surface "already
 * acquiring X" and offer cancel-first. A manual grab may override scoring
 * policy, never slot exclusivity.
 */
export class AcquisitionService {
	/**
	 * Reserve the target slots for a new acquisition. Returns a conflict
	 * (with the winning intent's details) when a slot or the release
	 * identity is already actively reserved.
	 */
	createIntent(input: CreateIntentInput, retried = false): CreateIntentResult {
		if (input.mediaType === 'movie' && !input.movieId) {
			throw new Error('Movie intents require movieId');
		}
		if (input.mediaType === 'tv' && (input.episodeIds ?? []).length === 0) {
			throw new Error('TV intents require a non-empty expanded episode scope');
		}

		const keys = targetKeysFor(input);
		const intentId = randomUUID();
		const now = new Date().toISOString();

		try {
			db.transaction((tx) => {
				tx.insert(acquisitionIntents)
					.values({
						id: intentId,
						mediaType: input.mediaType,
						movieId: input.movieId ?? null,
						seriesId: input.seriesId ?? null,
						seasonNumber: input.seasonNumber ?? null,
						episodeIds: input.mediaType === 'tv' ? (input.episodeIds ?? []) : null,
						qualitySlot: input.qualitySlot,
						protocol: input.protocol,
						identityKind: input.identity?.kind ?? null,
						identityValue: input.identity?.value ?? null,
						releaseTitle: input.releaseTitle,
						indexerId: input.indexerId ?? null,
						indexerName: input.indexerName ?? null,
						upgradeStatus: input.upgradeStatus ?? null,
						decision: input.decision ?? null,
						source: input.source,
						status: 'active',
						queueId: input.queueId ?? null,
						createdAt: now,
						updatedAt: now
					})
					.run();
				for (const targetKey of keys) {
					tx.insert(acquisitionReservations).values({ intentId, targetKey, createdAt: now }).run();
				}
			});
		} catch (error) {
			if (isUniqueViolation(error)) {
				const conflict = this.findConflict(input, keys);
				if (conflict) {
					return {
						ok: false,
						kind: conflict.byIdentity ? 'identity_conflict' : 'slot_conflict',
						conflict: conflict.conflict
					};
				}
				// Constraint fired but the conflicting row is no longer visible
				// (released between rollback and read). Retry once, then fail.
				if (retried) {
					logger.warn(
						{ releaseTitle: input.releaseTitle },
						'Intent insert conflict unresolved on retry'
					);
					throw error;
				}
				return this.createIntent(input, true);
			}
			throw error;
		}

		return { ok: true, intentId };
	}

	private findConflict(
		input: CreateIntentInput,
		keys: string[]
	): { conflict: IntentConflict; byIdentity: boolean } | undefined {
		const byIdentity = input.identity ? this.findActiveByIdentity(input.identity.value) : undefined;
		if (byIdentity) {
			return {
				conflict: toConflict(byIdentity, 'identity'),
				byIdentity: true
			};
		}
		const bySlot = this.findActiveByTargetKeys(keys);
		if (bySlot) {
			return { conflict: toConflict(bySlot, bySlot.targetKey), byIdentity: false };
		}
		return undefined;
	}

	/** Attach the queue row once the transport accepted the download. */
	attachQueueId(intentId: string, queueId: string): void {
		db.update(acquisitionIntents)
			.set({ queueId, updatedAt: new Date().toISOString() })
			.where(eq(acquisitionIntents.id, intentId))
			.run();
	}

	/**
	 * Record the canonical release identity once resolved (e.g. torrent info
	 * hash discovered after metadata fetch). Returns a conflict when the
	 * identity is already actively reserved by another intent — the caller
	 * must abort and release the duplicate acquisition.
	 */
	setIdentity(
		intentId: string,
		identity: ReleaseIdentity
	): { ok: true } | { ok: false; conflict: IntentConflict } {
		const now = new Date().toISOString();
		try {
			db.update(acquisitionIntents)
				.set({ identityKind: identity.kind, identityValue: identity.value, updatedAt: now })
				.where(and(eq(acquisitionIntents.id, intentId), eq(acquisitionIntents.status, 'active')))
				.run();
			return { ok: true };
		} catch (error) {
			if (isUniqueViolation(error)) {
				const existing = this.findActiveByIdentity(identity.value);
				if (existing && existing.id !== intentId) {
					return { ok: false, conflict: toConflict(existing, 'identity') };
				}
				// Our own row already carries this identity — not a conflict.
				return { ok: true };
			}
			throw error;
		}
	}

	completeIntent(intentId: string): void {
		this.finishIntent(intentId, 'completed');
	}

	failIntent(intentId: string, error: string): void {
		this.finishIntent(intentId, 'failed', error);
	}

	cancelIntent(intentId: string, reason?: string): void {
		this.finishIntent(intentId, 'canceled', reason);
	}

	/**
	 * Queue-linked lifecycle helpers. Idempotent no-ops when the queue row
	 * has no active intent (pre-migration legacy rows). These keep slot
	 * reservations in lockstep with the transport lifecycle: import
	 * completes, terminal failure fails, user removal cancels.
	 */
	completeByQueueId(queueId: string): void {
		const intent = this.findActiveByQueueId(queueId);
		if (intent) this.completeIntent(intent.id);
	}

	failByQueueId(queueId: string, error: string): void {
		const intent = this.findActiveByQueueId(queueId);
		if (intent) this.failIntent(intent.id, error);
	}

	cancelByQueueId(queueId: string, reason?: string): void {
		const intent = this.findActiveByQueueId(queueId);
		if (intent) this.cancelIntent(intent.id, reason);
	}

	/**
	 * Release download_queue rows created by the Unmatched-tab track/enroll
	 * flow for a movie/series being unmatched, so the torrent resurfaces in
	 * Unmatched. Only rows explicitly stamped with `origin` qualify - NOT
	 * "indexerId is null", which also matches legitimate arr_push-pushed
	 * grabs and would wrongly release those too.
	 *
	 * Rows actively `importing`/`postprocessing` are left alone rather than
	 * cancelled+deleted: ImportService holds an in-memory snapshot of the
	 * row and never re-queries it, so deleting it mid-import wouldn't stop
	 * the import - it would just silently orphan the queue row while the
	 * import completes anyway, and releasing the acquisition slot early
	 * could let a duplicate grab start concurrently. Those rows are left for
	 * the import to finish/fail naturally; the caller's `heldBack` count
	 * still counts them as "something to release" for guard purposes.
	 */
	releaseUnmatchedQueueItems(
		target: { movieId: string } | { seriesId: string },
		reason: string
	): { released: number; heldBack: number } {
		const mediaFilter =
			'movieId' in target
				? eq(downloadQueue.movieId, target.movieId)
				: eq(downloadQueue.seriesId, target.seriesId);

		const rows = db
			.select({ id: downloadQueue.id, status: downloadQueue.status })
			.from(downloadQueue)
			.where(
				and(mediaFilter, inArray(downloadQueue.origin, ['unmatched_track', 'unmatched_enroll']))
			)
			.all();

		let released = 0;
		let heldBack = 0;
		for (const row of rows) {
			if (row.status === 'importing' || row.status === 'postprocessing') {
				heldBack++;
				continue;
			}
			this.cancelByQueueId(row.id, reason);
			db.delete(downloadQueue).where(eq(downloadQueue.id, row.id)).run();
			released++;
		}
		return { released, heldBack };
	}

	findActiveByQueueId(queueId: string) {
		return db
			.select()
			.from(acquisitionIntents)
			.where(and(eq(acquisitionIntents.queueId, queueId), eq(acquisitionIntents.status, 'active')))
			.limit(1)
			.all()[0];
	}

	/**
	 * Re-arm the acquisition authority for a failed queue row being retried
	 * (re-download / client retry). Without this the retried transport runs
	 * with no reservation, so a concurrent automatic grab for the same slot
	 * can be accepted and the retry later completes into nothing.
	 *
	 * Returns the existing active intent when one is already linked, otherwise
	 * creates one from the row's stored target/quality/identity. A slot or
	 * identity conflict refuses the retry instead of double-acquiring.
	 */
	async rearmForQueueId(
		queueId: string
	): Promise<{ ok: true; intentId: string } | { ok: false; reason: string }> {
		const row = db.select().from(downloadQueue).where(eq(downloadQueue.id, queueId)).get();
		if (!row) return { ok: false, reason: 'Queue item not found' };

		const existing = this.findActiveByQueueId(queueId);
		if (existing) return { ok: true, intentId: existing.id };

		const identity: ReleaseIdentity | undefined = row.infoHash
			? { kind: 'info_hash', value: row.infoHash }
			: undefined;

		let result: CreateIntentResult;
		if (row.movieId) {
			const movie = db.select().from(movies).where(eq(movies.id, row.movieId)).get();
			const slot = await computeMovieQualitySlot(
				movie?.desiredQualities ?? null,
				movie?.scoringProfileId ?? null,
				(row.quality?.resolution ?? undefined) as Resolution | undefined
			);
			result = this.createIntent({
				mediaType: 'movie',
				movieId: row.movieId,
				qualitySlot: slot,
				protocol: row.protocol,
				identity,
				releaseTitle: row.title,
				indexerId: row.indexerId ?? undefined,
				indexerName: row.indexerName ?? undefined,
				source: 'manual',
				queueId: row.id
			});
		} else if (row.seriesId) {
			const episodeIds = (row.episodeIds ?? []).filter((episodeId): episodeId is string =>
				Boolean(episodeId)
			);
			if (episodeIds.length === 0) {
				return { ok: false, reason: 'Queue item has no episode scope to reserve' };
			}
			result = this.createIntent({
				mediaType: 'tv',
				seriesId: row.seriesId,
				seasonNumber: row.seasonNumber ?? undefined,
				episodeIds,
				qualitySlot: 'episodes',
				protocol: row.protocol,
				identity,
				releaseTitle: row.title,
				indexerId: row.indexerId ?? undefined,
				indexerName: row.indexerName ?? undefined,
				source: 'manual',
				queueId: row.id
			});
		} else {
			return { ok: false, reason: 'Queue item has no media target' };
		}

		if (!result.ok) {
			const { conflict, kind } = result;
			return {
				ok: false,
				reason:
					kind === 'identity_conflict'
						? `Duplicate release "${conflict.releaseTitle}" is already being acquired`
						: `"${conflict.releaseTitle}" is already being acquired for this slot — wait for it or remove it first`
			};
		}

		logger.info(
			{ queueId, intentId: result.intentId },
			'Re-armed acquisition intent for queue retry'
		);
		return { ok: true, intentId: result.intentId };
	}

	/** Release every reservation still held by the intent. */
	private finishIntent(intentId: string, status: IntentStatus, error?: string): void {
		const now = new Date().toISOString();
		db.transaction((tx) => {
			tx.update(acquisitionIntents)
				.set({
					status,
					error: error ?? null,
					completedAt: status === 'active' ? null : now,
					updatedAt: now
				})
				.where(and(eq(acquisitionIntents.id, intentId), eq(acquisitionIntents.status, 'active')))
				.run();
			tx.update(acquisitionReservations)
				.set({ releasedAt: now })
				.where(
					and(
						eq(acquisitionReservations.intentId, intentId),
						isNull(acquisitionReservations.releasedAt)
					)
				)
				.run();
		});
	}

	findActiveByIdentity(identityValue: string) {
		// Synchronous on purpose: callers use the result inside the unique-
		// violation conflict path after the transaction rolled back.
		return db
			.select()
			.from(acquisitionIntents)
			.where(
				and(
					eq(acquisitionIntents.identityValue, identityValue),
					eq(acquisitionIntents.status, 'active')
				)
			)
			.limit(1)
			.all()[0];
	}

	findActiveByTargetKeys(keys: string[]) {
		if (keys.length === 0) return undefined;
		const activeReservation = db
			.select({
				intentId: acquisitionReservations.intentId,
				targetKey: acquisitionReservations.targetKey
			})
			.from(acquisitionReservations)
			.where(
				and(
					inArray(acquisitionReservations.targetKey, keys),
					isNull(acquisitionReservations.releasedAt)
				)
			)
			.limit(1)
			.all()[0];
		if (!activeReservation) return undefined;

		const intent = db
			.select()
			.from(acquisitionIntents)
			.where(
				and(
					eq(acquisitionIntents.id, activeReservation.intentId),
					eq(acquisitionIntents.status, 'active')
				)
			)
			.limit(1)
			.all()[0];
		if (!intent) return undefined;
		return { ...intent, targetKey: activeReservation.targetKey };
	}

	/** Active reservation keys for a target — the occupancy read path. */
	getActiveReservationKeys(keys: string[]): string[] {
		if (keys.length === 0) return [];
		const rows = db
			.select({ targetKey: acquisitionReservations.targetKey })
			.from(acquisitionReservations)
			.where(
				and(
					inArray(acquisitionReservations.targetKey, keys),
					isNull(acquisitionReservations.releasedAt)
				)
			)
			.all();
		return rows.map((row) => row.targetKey);
	}

	/**
	 * Any active reservation on any quality slot of a movie — used when the
	 * candidate's bucket is unknown or single-quality, where any active
	 * acquisition for the movie should block.
	 */
	findActiveMovieReservation(movieId: string) {
		const activeReservation = db
			.select({
				intentId: acquisitionReservations.intentId,
				targetKey: acquisitionReservations.targetKey
			})
			.from(acquisitionReservations)
			.where(
				and(
					like(acquisitionReservations.targetKey, `movie:${movieId}:%`),
					isNull(acquisitionReservations.releasedAt)
				)
			)
			.limit(1)
			.all()[0];
		if (!activeReservation) return undefined;

		const intent = db
			.select()
			.from(acquisitionIntents)
			.where(
				and(
					eq(acquisitionIntents.id, activeReservation.intentId),
					eq(acquisitionIntents.status, 'active')
				)
			)
			.limit(1)
			.all()[0];
		if (!intent) return undefined;

		return { ...intent, targetKey: activeReservation.targetKey };
	}

	/** Count of active intents — for reports/reconciliation diagnostics. */
	countActiveIntents(): number {
		const row = db
			.select({ count: sql<number>`count(*)` })
			.from(acquisitionIntents)
			.where(eq(acquisitionIntents.status, 'active'))
			.all()[0];
		return row?.count ?? 0;
	}

	/**
	 * Release reservations whose transport is gone: the linked queue row no
	 * longer exists (or is in a terminal state) while the intent is still
	 * active. Covers crashes between handler success and queue write, and
	 * legacy rows from before migration 148. Called at monitor startup.
	 * Returns the number of reconciled intents.
	 */
	reconcileStaleIntents(): number {
		const activeIntents = db
			.select({ id: acquisitionIntents.id, queueId: acquisitionIntents.queueId })
			.from(acquisitionIntents)
			.where(eq(acquisitionIntents.status, 'active'))
			.all();

		let reconciled = 0;
		for (const intent of activeIntents) {
			// Intents without a queue row yet are in-flight grabs (handler
			// running); only age them out — 6h means the process died mid-grab.
			if (!intent.queueId) {
				const stale = db
					.select({ createdAt: acquisitionIntents.createdAt })
					.from(acquisitionIntents)
					.where(eq(acquisitionIntents.id, intent.id))
					.limit(1)
					.all()[0];
				const ageMs = Date.now() - new Date(stale?.createdAt ?? Date.now()).getTime();
				if (ageMs > 6 * 60 * 60 * 1000) {
					this.failIntent(intent.id, 'reconciled: no transport appeared within 6h');
					reconciled++;
				}
				continue;
			}

			const queueRow = db
				.select({ id: downloadQueue.id, status: downloadQueue.status })
				.from(downloadQueue)
				.where(eq(downloadQueue.id, intent.queueId))
				.limit(1)
				.all()[0];

			const terminal = ['removed', 'failed', 'imported', 'seeding-imported'];
			if (!queueRow || terminal.includes(queueRow.status)) {
				logger.info(
					{ intentId: intent.id, queueId: intent.queueId, queueStatus: queueRow?.status },
					'[AcquisitionService] Reconciling stale intent'
				);
				this.finishIntent(
					intent.id,
					'failed',
					`reconciled: queue row ${queueRow ? `is ${queueRow.status}` : 'is gone'}`
				);
				reconciled++;
			}
		}
		return reconciled;
	}
}

function toConflict(
	intent: {
		id: string;
		releaseTitle: string;
		source: string;
		status: string;
		queueId: string | null;
		createdAt: string;
	},
	targetKey: string
): IntentConflict {
	return {
		intentId: intent.id,
		targetKey,
		releaseTitle: intent.releaseTitle,
		source: intent.source,
		status: intent.status,
		queueId: intent.queueId,
		createdAt: intent.createdAt
	};
}

export const acquisitionService = new AcquisitionService();

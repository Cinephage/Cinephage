import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { releaseEvents } from '#lib/server/db/schema.js';
import type { NewReleaseEvent, ReleaseEvent, ReleaseKind, ReleaseMediaType } from './types.js';

/**
 * Persistence for `release_events`.
 *
 * No repository layer by convention — the store is a thin, typed wrapper over
 * Drizzle so the service never builds queries inline and tests can stub it.
 */

export async function listEvents(
	mediaType: ReleaseMediaType,
	mediaId: string
): Promise<ReleaseEvent[]> {
	const rows = await db
		.select()
		.from(releaseEvents)
		.where(and(eq(releaseEvents.mediaType, mediaType), eq(releaseEvents.mediaId, mediaId)))
		.orderBy(asc(releaseEvents.releaseDate));

	return rows as ReleaseEvent[];
}

export interface EventRangeQuery {
	from: string;
	to: string;
	kinds?: readonly ReleaseKind[];
	region?: string;
	mediaType?: ReleaseMediaType;
}

export async function listEventsInRange(query: EventRangeQuery): Promise<ReleaseEvent[]> {
	const conditions = [
		gte(releaseEvents.releaseDate, query.from),
		lte(releaseEvents.releaseDate, query.to)
	];
	if (query.kinds?.length) conditions.push(inArray(releaseEvents.kind, [...query.kinds]));
	if (query.region) conditions.push(eq(releaseEvents.region, query.region));
	if (query.mediaType) conditions.push(eq(releaseEvents.mediaType, query.mediaType));

	const rows = await db
		.select()
		.from(releaseEvents)
		.where(and(...conditions))
		.orderBy(asc(releaseEvents.releaseDate));

	return rows as ReleaseEvent[];
}

/**
 * Insert-or-update on the natural key. SQLite treats NULLs as distinct in a
 * unique index, so callers must supply `sourceId` for this to be idempotent —
 * provider-produced events always do.
 */
export async function upsertEvents(events: readonly NewReleaseEvent[]): Promise<number> {
	if (events.length === 0) return 0;
	const now = new Date().toISOString();

	for (const event of events) {
		await db
			.insert(releaseEvents)
			.values({ ...event, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: [
					releaseEvents.mediaType,
					releaseEvents.mediaId,
					releaseEvents.kind,
					releaseEvents.region,
					releaseEvents.releaseDate,
					releaseEvents.sourceId
				],
				set: {
					platform: event.platform,
					releaseTime: event.releaseTime,
					timezone: event.timezone,
					confidence: event.confidence,
					updatedAt: now
				}
			});
	}

	return events.length;
}

/**
 * Drop events this source no longer reports for the media (a cancelled
 * premiere, a corrected date). Only ever touches rows belonging to `source`.
 */
export async function pruneEvents(
	mediaType: ReleaseMediaType,
	mediaId: string,
	source: string,
	keepSourceIds: readonly string[]
): Promise<number> {
	const existing = await db
		.select({ id: releaseEvents.id, sourceId: releaseEvents.sourceId })
		.from(releaseEvents)
		.where(
			and(
				eq(releaseEvents.mediaType, mediaType),
				eq(releaseEvents.mediaId, mediaId),
				eq(releaseEvents.source, source)
			)
		);

	const keep = new Set(keepSourceIds);
	const stale = existing.filter((row) => !row.sourceId || !keep.has(row.sourceId));
	if (stale.length === 0) return 0;

	await db.delete(releaseEvents).where(
		inArray(
			releaseEvents.id,
			stale.map((row) => row.id)
		)
	);

	return stale.length;
}

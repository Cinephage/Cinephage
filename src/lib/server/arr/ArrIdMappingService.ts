/**
 * ArrIdMappingService - surrogate integer IDs for the Radarr/Sonarr-compatible
 * API layer.
 *
 * Cinephage's own entities (root folders, scoring profiles, movies, series,
 * ...) use UUID text primary keys, but the Radarr/Sonarr v3 contract types
 * every ID as an integer - client libraries (autobrr, Overseerr, ArrAPI)
 * decode fields like `qualityProfileId` as ints. This service assigns a
 * stable integer per (entityType, entityId) pair the first time it's exposed
 * through the compat layer and reuses it on every later request, so IDs
 * don't shift across requests or restarts.
 */

import { db } from '#lib/server/db/index.js';
import { arrIdMappings } from '#lib/server/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';

/** Entity kinds the arr-compat layer assigns surrogate IDs for. */
export type ArrEntityType =
	| 'rootFolder'
	| 'qualityProfile'
	| 'tag'
	| 'movie'
	| 'series'
	| 'episode'
	| 'queue'
	| 'blocklist'
	| 'history'
	| 'movieFile'
	| 'episodeFile'
	| 'release'
	| 'rename'
	| 'language'
	| 'languageProfile'
	| 'downloadClient'
	| 'notification'
	| 'blockedMedia';

/**
 * Get (or assign, on first use) the surrogate integer ID for a single entity.
 */
export async function getOrAssignArrId(
	entityType: ArrEntityType,
	entityId: string
): Promise<number> {
	const map = await getOrAssignArrIds(entityType, [entityId]);
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- entityId is always present, we just inserted or read it
	return map.get(entityId)!;
}

/**
 * Get (or assign) surrogate integer IDs for a batch of entities in one
 * round trip - the list endpoints (rootfolder, qualityprofile, ...) map a
 * whole result set at once rather than doing one lookup per row.
 */
export async function getOrAssignArrIds(
	entityType: ArrEntityType,
	entityIds: string[]
): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	const uniqueIds = [...new Set(entityIds)];
	if (uniqueIds.length === 0) return result;

	const existing = await db
		.select({ id: arrIdMappings.id, entityId: arrIdMappings.entityId })
		.from(arrIdMappings)
		.where(
			and(eq(arrIdMappings.entityType, entityType), inArray(arrIdMappings.entityId, uniqueIds))
		);

	for (const row of existing) {
		result.set(row.entityId, row.id);
	}

	const missing = uniqueIds.filter((id) => !result.has(id));
	for (const entityId of missing) {
		// One INSERT at a time so a race with another request hitting the same
		// (entityType, entityId) pair fails the unique index cleanly instead of
		// silently producing two IDs for the same entity.
		try {
			const inserted = await db
				.insert(arrIdMappings)
				.values({ entityType, entityId })
				.returning({ id: arrIdMappings.id });
			result.set(entityId, inserted[0].id);
		} catch {
			// Another request won the race and inserted it first - read back
			// the ID it assigned rather than treating this as a failure.
			const row = await db
				.select({ id: arrIdMappings.id })
				.from(arrIdMappings)
				.where(and(eq(arrIdMappings.entityType, entityType), eq(arrIdMappings.entityId, entityId)))
				.limit(1);
			if (row[0]) result.set(entityId, row[0].id);
		}
	}

	return result;
}

/**
 * Reverse lookup: resolve a surrogate integer ID back to its Cinephage UUID.
 * Used wherever an arr client sends an ID back in (route params, request
 * bodies) that needs translating back to a real Cinephage entity - e.g.
 * release.ts's search/grab, command.ts's command dispatch, rename.ts, and
 * the Sonarr episode endpoint.
 */
export async function getEntityIdForArrId(
	entityType: ArrEntityType,
	arrId: number
): Promise<string | undefined> {
	const row = await db
		.select({ entityId: arrIdMappings.entityId })
		.from(arrIdMappings)
		.where(and(eq(arrIdMappings.entityType, entityType), eq(arrIdMappings.id, arrId)))
		.limit(1);
	return row[0]?.entityId;
}

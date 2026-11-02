import { db } from '#lib/server/db/index.js';
import { movies, series, blockedMedia, requests } from '#lib/server/db/schema.js';
import { inArray, eq, and, desc } from 'drizzle-orm';

/**
 * Library status for a single TMDB item
 */
export interface LibraryStatus {
	inLibrary: boolean;
	hasFile: boolean;
	monitored?: boolean;
	mediaType: 'movie' | 'tv' | null;
	libraryId?: string;
	releaseDate?: string | null;
	digitalReleaseDate?: string | null;
	physicalReleaseDate?: string | null;
}

/**
 * Response map: tmdbId -> LibraryStatus
 */
export type LibraryStatusMap = Record<number, LibraryStatus>;

/**
 * Batch lookup library status for multiple TMDB IDs.
 * This is the server-side implementation used by both page loaders and API endpoints.
 *
 * @param tmdbIds - Array of TMDB IDs to look up
 * @param mediaType - Optional filter: 'movie', 'tv', or 'all' (default)
 * @returns Map of tmdbId -> LibraryStatus
 */
export async function getLibraryStatus(
	tmdbIds: number[],
	mediaType: 'movie' | 'tv' | 'all' = 'all'
): Promise<LibraryStatusMap> {
	if (!Array.isArray(tmdbIds) || tmdbIds.length === 0) {
		return {};
	}

	// Deduplicate and limit to prevent abuse
	const uniqueIds = [...new Set(tmdbIds)].slice(0, 500);

	// Initialize result map with all IDs as not in library
	const statusMap: LibraryStatusMap = {};
	for (const id of uniqueIds) {
		statusMap[id] = {
			inLibrary: false,
			hasFile: false,
			mediaType: null
		};
	}

	// Query movies if needed
	if (mediaType === 'all' || mediaType === 'movie') {
		const libraryMovies = await db
			.select({
				id: movies.id,
				tmdbId: movies.tmdbId,
				hasFile: movies.hasFile,
				monitored: movies.monitored,
				releaseDate: movies.releaseDate,
				digitalReleaseDate: movies.digitalReleaseDate,
				physicalReleaseDate: movies.physicalReleaseDate
			})
			.from(movies)
			.where(inArray(movies.tmdbId, uniqueIds));

		for (const movie of libraryMovies) {
			statusMap[movie.tmdbId] = {
				inLibrary: true,
				hasFile: movie.hasFile ?? false,
				monitored: movie.monitored ?? true,
				mediaType: 'movie',
				libraryId: movie.id,
				releaseDate: movie.releaseDate,
				digitalReleaseDate: movie.digitalReleaseDate,
				physicalReleaseDate: movie.physicalReleaseDate
			};
		}
	}

	// Query series if needed
	if (mediaType === 'all' || mediaType === 'tv') {
		const librarySeries = await db
			.select({
				id: series.id,
				tmdbId: series.tmdbId,
				monitored: series.monitored,
				episodeFileCount: series.episodeFileCount
			})
			.from(series)
			.where(inArray(series.tmdbId, uniqueIds));

		for (const show of librarySeries) {
			// For series, hasFile means at least one episode file exists
			const hasFile = (show.episodeFileCount ?? 0) > 0;
			statusMap[show.tmdbId] = {
				inLibrary: true,
				hasFile,
				monitored: show.monitored ?? true,
				mediaType: 'tv',
				libraryId: show.id
			};
		}
	}

	return statusMap;
}

/**
 * Enrich TMDB media items with library status.
 * Adds `inLibrary`, `hasFile`, and `libraryId` properties to each item.
 *
 * @param items - Array of TMDB media items (must have `id` property)
 * @param mediaType - Optional filter for lookup
 * @returns Same array with library status properties added
 */
export async function enrichWithLibraryStatus<T extends { id: number }>(
	items: T[],
	mediaType: 'movie' | 'tv' | 'all' = 'all'
): Promise<
	(T & {
		inLibrary: boolean;
		hasFile: boolean;
		monitored?: boolean;
		libraryId?: string;
		releaseDate?: string | null;
		digitalReleaseDate?: string | null;
		physicalReleaseDate?: string | null;
	})[]
> {
	if (!items || items.length === 0) {
		return [];
	}

	const tmdbIds = items.map((item) => item.id);
	const statusMap = await getLibraryStatus(tmdbIds, mediaType);

	return items.map((item) => {
		const status = statusMap[item.id];
		return {
			...item,
			inLibrary: status?.inLibrary ?? false,
			hasFile: status?.hasFile ?? false,
			monitored: status?.monitored,
			libraryId: status?.libraryId,
			releaseDate: status?.releaseDate ?? null,
			digitalReleaseDate: status?.digitalReleaseDate ?? null,
			physicalReleaseDate: status?.physicalReleaseDate ?? null
		};
	});
}

/**
 * Filter out items already in library.
 * Generic utility to remove code duplication across discover views.
 *
 * @param items - Array of items with library status
 * @param exclude - Whether to exclude items in library (true = filter them out)
 * @returns Filtered array
 */
export function filterInLibrary<T extends { inLibrary?: boolean }>(
	items: T[],
	exclude: boolean
): T[] {
	if (!exclude) return items;
	return items.filter((item) => !item.inLibrary);
}

/**
 * Get all blocked TMDB IDs as a Set for fast lookup.
 * Cached per-request via module-level cache with TTL.
 */
let blockedCache: Record<string, { ids: Set<number>; expiry: number }> = {};
const BLOCKED_CACHE_TTL = 30_000;

export async function getBlockedTmdbIdSet(
	mediaType: 'movie' | 'tv' | 'all' = 'all'
): Promise<Set<number>> {
	const now = Date.now();
	const cached = blockedCache[mediaType];
	if (cached && cached.expiry > now) {
		return cached.ids;
	}

	const conditions = mediaType !== 'all' ? [eq(blockedMedia.mediaType, mediaType)] : [];

	const rows = await db
		.select({ tmdbId: blockedMedia.tmdbId })
		.from(blockedMedia)
		.where(conditions.length > 0 ? and(...conditions) : undefined);

	const ids = new Set(rows.map((r) => r.tmdbId));
	blockedCache[mediaType] = { ids, expiry: now + BLOCKED_CACHE_TTL };

	return ids;
}

export function invalidateBlockedCache(): void {
	blockedCache = {};
}

/**
 * Request-state annotation for TMDB items (the discover/detail sibling of
 * getLibraryStatus). One indexed query per list; statuses collapse to the
 * badge vocabulary pending / approved / fulfilled.
 */
export type RequestedState = 'none' | 'pending' | 'approved' | 'fulfilled';

export interface RequestStateAnnotation {
	requested: RequestedState;
	/** Representative active request id (admin actions on detail pages). */
	requestId: string | null;
	/** The viewing user's own active request, when one exists. */
	ownRequestId: string | null;
}

export type RequestStateMap = Record<number, RequestStateAnnotation>;

const REQUEST_STATUS_TO_STATE: Record<string, RequestedState> = {
	pending: 'pending',
	failed: 'pending',
	approved: 'approved',
	awaiting_target: 'approved',
	fulfilled: 'fulfilled'
};

const STATE_PRECEDENCE: Record<RequestedState, number> = {
	fulfilled: 3,
	pending: 2,
	approved: 1,
	none: 0
};

export async function getRequestStateMap(
	tmdbIds: number[],
	mediaType: 'movie' | 'tv' | 'all',
	viewerId: string | null
): Promise<RequestStateMap> {
	const uniqueIds = [...new Set(tmdbIds)].slice(0, 500);
	const map: RequestStateMap = {};
	if (uniqueIds.length === 0) return map;
	for (const id of uniqueIds) {
		map[id] = { requested: 'none', requestId: null, ownRequestId: null };
	}

	const rows = await db
		.select({
			id: requests.id,
			tmdbId: requests.tmdbId,
			status: requests.status,
			requestedBy: requests.requestedBy,
			createdAt: requests.createdAt
		})
		.from(requests)
		.where(
			and(
				inArray(requests.tmdbId, uniqueIds),
				mediaType === 'all'
					? undefined
					: eq(requests.mediaType, mediaType === 'tv' ? 'series' : 'movie')
			)
		)
		.orderBy(desc(requests.createdAt));

	for (const row of rows) {
		const state = REQUEST_STATUS_TO_STATE[row.status];
		if (!state) continue; // declined/expired/cancelled never annotate
		const current = map[row.tmdbId];
		if (!current) continue;
		if (STATE_PRECEDENCE[state] > STATE_PRECEDENCE[current.requested]) {
			current.requested = state;
			current.requestId = row.id;
		}
		if (viewerId && row.requestedBy === viewerId && STATE_PRECEDENCE[state] >= 1) {
			current.ownRequestId ??= row.id;
		}
	}
	return map;
}

/**
 * Annotate TMDB items with request state (requested / requestId /
 * ownRequestId), mirroring enrichWithLibraryStatus.
 */
export async function annotateRequestState<T extends { id: number }>(
	items: T[],
	mediaType: 'movie' | 'tv' | 'all',
	viewerId: string | null
): Promise<(T & RequestStateAnnotation)[]> {
	if (!items || items.length === 0) {
		return [];
	}
	const stateMap = await getRequestStateMap(
		items.map((item) => item.id),
		mediaType,
		viewerId
	);
	return items.map((item) => {
		const state = stateMap[item.id];
		return {
			...item,
			requested: state?.requested ?? 'none',
			requestId: state?.requestId ?? null,
			ownRequestId: state?.ownRequestId ?? null
		};
	});
}

/**
 * Filter out blocked media items from a list.
 * Items are matched by their `id` (TMDB ID) property.
 *
 * @param items - Array of items with `id` (TMDB ID) property
 * @param mediaType - Filter for which media type to check
 * @returns Filtered array with blocked items removed
 */
export async function filterBlockedMedia<T extends { id: number; media_type?: string }>(
	items: T[],
	mediaType: 'movie' | 'tv' | 'all' = 'all'
): Promise<T[]> {
	if (!items || items.length === 0) {
		return items ?? [];
	}

	const blockedIds = await getBlockedTmdbIdSet(mediaType);
	if (blockedIds.size === 0) {
		return items;
	}

	return items.filter((item) => !blockedIds.has(item.id));
}

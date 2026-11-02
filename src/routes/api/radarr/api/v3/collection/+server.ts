import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/collection
 * Skeleton - Cinephage has no TMDB-collection-tracking equivalent yet.
 */
export const GET: RequestHandler = emptyListSkeleton;

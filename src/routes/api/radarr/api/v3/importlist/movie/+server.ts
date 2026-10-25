import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/importlist/movie
 * Skeleton - no import-list recommendation/trending/popular data source yet.
 */
export const GET: RequestHandler = emptyListSkeleton;

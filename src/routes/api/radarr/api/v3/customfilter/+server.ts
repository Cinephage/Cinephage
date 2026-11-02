import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/customfilter
 * Skeleton - Cinephage has no custom-filter (saved search filter) concept.
 */
export const GET: RequestHandler = emptyListSkeleton;

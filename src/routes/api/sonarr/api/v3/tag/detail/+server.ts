import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/sonarr/api/v3/tag/detail
 * Skeleton - Cinephage has no normalized tag registry yet (see /tag).
 */
export const GET: RequestHandler = emptyListSkeleton;

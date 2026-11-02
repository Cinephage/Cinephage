import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/credit
 * Skeleton - Cinephage doesn't track cast/crew credits.
 */
export const GET: RequestHandler = emptyListSkeleton;

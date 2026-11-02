import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/sonarr/api/v3/importlist/schema
 * Skeleton - no import-list provider templates to offer.
 */
export const GET: RequestHandler = emptyListSkeleton;

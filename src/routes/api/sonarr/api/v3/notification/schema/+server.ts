import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/sonarr/api/v3/notification/schema
 * Skeleton - no notification provider templates to offer.
 */
export const GET: RequestHandler = emptyListSkeleton;

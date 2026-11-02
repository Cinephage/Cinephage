import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/sonarr/api/v3/remotepathmapping
 * Skeleton - download clients already carry their own path mapping fields; no separate global list.
 */
export const GET: RequestHandler = emptyListSkeleton;

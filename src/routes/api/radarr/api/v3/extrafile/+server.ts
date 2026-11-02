import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/extrafile
 * Skeleton - Cinephage has no extras-file tracking (trailers/behind-the-scenes) equivalent.
 */
export const GET: RequestHandler = emptyListSkeleton;

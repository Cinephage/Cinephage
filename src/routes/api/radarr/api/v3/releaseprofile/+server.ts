import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/releaseprofile
 * Skeleton - Cinephage's scoring profiles cover this differently; no direct release-profile equivalent.
 */
export const GET: RequestHandler = emptyListSkeleton;

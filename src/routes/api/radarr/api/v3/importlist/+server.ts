import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/importlist
 * Skeleton - Cinephage has no Radarr/Sonarr-style import-list provider concept.
 */
export const GET: RequestHandler = emptyListSkeleton;

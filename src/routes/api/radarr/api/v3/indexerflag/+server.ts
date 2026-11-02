import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/radarr/api/v3/indexerflag
 * Skeleton - Cinephage's indexers don't use Radarr/Sonarr's flag system.
 */
export const GET: RequestHandler = emptyListSkeleton;

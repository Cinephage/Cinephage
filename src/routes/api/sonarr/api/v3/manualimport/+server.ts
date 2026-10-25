import type { RequestHandler } from './$types';
import { emptyListSkeleton } from '#lib/server/arr/skeleton.js';

/**
 * GET /api/sonarr/api/v3/manualimport
 * Skeleton - Cinephage has its own manual-import flow (library import wizard), not staged the same way.
 */
export const GET: RequestHandler = emptyListSkeleton;

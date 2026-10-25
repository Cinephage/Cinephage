/**
 * Shared handler for arr-compat endpoints where Cinephage has no matching
 * concept yet (custom filters, notification providers, import-list
 * providers, extra files, TMDB collections, remote path mappings, ...).
 *
 * Every one of these is a list endpoint in the real Radarr/Sonarr spec, so
 * an empty array is schema-correct across the board and honestly reflects
 * "nothing configured/available" rather than fabricating data. Kept in one
 * place so the ~20 route files that use it stay a one-line re-export each,
 * and so revisiting this decision (building a real one out) only means
 * replacing that one file's import, not hunting through duplicated guard
 * logic.
 */
import { type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from './requireArrCompatEnabled.js';

export const emptyListSkeleton: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json([]);
};

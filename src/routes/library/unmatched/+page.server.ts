import type { PageServerLoad } from './$types';
import { requireAdminPage } from '#lib/server/auth/authorization.js';

/**
 * Server load function - minimal since data is loaded client-side
 * This prevents unnecessary database queries on initial page load
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdminPage(locals);
	const source = url.searchParams.get('source');
	// Data is loaded client-side via unmatchedFilesStore
	// This avoids loading potentially large datasets on every page request
	return { source };
};

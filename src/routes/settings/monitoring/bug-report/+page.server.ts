import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);
	return {};
};

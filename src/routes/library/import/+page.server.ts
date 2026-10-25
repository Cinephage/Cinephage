import type { PageServerLoad } from './$types';
import { requireAdminPage } from '#lib/server/auth/authorization.js';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);
	return {};
};

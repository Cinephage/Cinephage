import type { LayoutServerLoad } from './$types';
import { requireAdminPage } from '#lib/server/auth/authorization.js';

export const load: LayoutServerLoad = async ({ locals }) => {
	requireAdminPage(locals);
	return {};
};

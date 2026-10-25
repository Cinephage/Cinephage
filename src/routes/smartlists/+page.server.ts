/**
 * Smart Lists Page - Server Load
 */

import type { PageServerLoad } from './$types';
import { getSmartListService } from '#lib/server/smartlists/index.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);
	const service = getSmartListService();
	const lists = await service.getAllSmartLists();

	return {
		lists
	};
};

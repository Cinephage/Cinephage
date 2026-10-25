/**
 * Edit Smart List Page - Server Load
 */

import type { PageServerLoad } from './$types';
import { getSmartListService } from '#lib/server/smartlists/index.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { db } from '#lib/server/db/index.js';
import { rootFolders, scoringProfiles } from '#lib/server/db/schema.js';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ locals, params }) => {
	requireAdminPage(locals);
	const service = getSmartListService();
	const list = await service.getSmartList(params.id);

	if (!list) {
		throw error(404, 'Smart list not found');
	}

	const folders = await db.select().from(rootFolders);
	const profiles = await db.select().from(scoringProfiles);

	return {
		list,
		rootFolders: folders,
		scoringProfiles: profiles
	};
};

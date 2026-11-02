/**
 * Create Smart List Page - Server Load
 */

import type { PageServerLoad } from './$types';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { db } from '#lib/server/db/index.js';
import { rootFolders, scoringProfiles } from '#lib/server/db/schema.js';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);
	const folders = await db.select().from(rootFolders);
	const profiles = await db.select().from(scoringProfiles);

	return {
		rootFolders: folders,
		scoringProfiles: profiles
	};
};

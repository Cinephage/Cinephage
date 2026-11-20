import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { musicScanIssueService } from '#lib/server/music/MusicScanIssueService.js';

/** Review queue for folders a music scan could not identify. */
export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);
	return { issues: musicScanIssueService.listPending() };
};

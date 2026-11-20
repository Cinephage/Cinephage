import type { RequestHandler } from './$types.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { musicScanIssueService } from '#lib/server/music/MusicScanIssueService.js';

/** GET /api/music/scan-issues — folders the scanner could not identify. */
export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	return Response.json({ success: true, issues: musicScanIssueService.listPending() });
};

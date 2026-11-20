import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { musicScanIssueService } from '#lib/server/music/MusicScanIssueService.js';

/** DELETE /api/music/scan-issues/[id] — dismiss a folder from the review queue. */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const ignored = musicScanIssueService.ignore(event.params.id);
	if (!ignored) return Response.json({ error: 'Scan issue not found' }, { status: 404 });
	return Response.json({ success: true });
};

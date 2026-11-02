import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	getPermissionRepairStatus,
	startPermissionRepair
} from '#lib/server/filesystem/permission-repair.js';

/**
 * GET /api/library/fix-media-permissions
 * Current state (and last result) of the media permission repair (issue #617).
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	return Response.json({ success: true, ...getPermissionRepairStatus() });
};

/**
 * POST /api/library/fix-media-permissions
 * Walk every configured root folder and chmod umask-truncated (0700/0600)
 * media dirs/files back to 0755/0644. Read-only roots are skipped. Runs in
 * the background; poll the GET endpoint for the summary.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	if (!startPermissionRepair()) {
		return Response.json(
			{ success: false, error: 'A media permission repair is already running' },
			{ status: 409 }
		);
	}

	return Response.json(
		{
			success: true,
			message: 'Media permission repair started',
			...getPermissionRepairStatus()
		},
		{ status: 202 }
	);
};

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { getCommand } from '#lib/server/arr/command.js';

/** GET /api/sonarr/api/v3/command/{id} - a client polls this to confirm a
 * command it submitted actually ran. Returning real status (rather than a
 * 404) is what stops it from assuming the command was lost and resubmitting. */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const id = Number(event.params.id);
	const command = Number.isFinite(id) ? getCommand(id) : undefined;
	if (!command) throw error(404, 'Command not found');

	return Response.json(command);
};

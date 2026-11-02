/**
 * Mark own notifications read. Body: { ids?: string[] } — omit ids to mark
 * everything read; an explicit empty array is a no-op.
 */

import type { RequestHandler } from './$types.js';
import { parseBody } from '#lib/server/api/validate.js';
import { getRequestNotificationService } from '#lib/server/requests/RequestNotificationService.js';
import { z } from 'zod';

const markReadSchema = z.object({
	ids: z.array(z.string().min(1)).max(200).optional()
});

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const { ids } = await parseBody(event.request, markReadSchema);
	await getRequestNotificationService().markRead(event.locals.user.id, ids);
	return Response.json({ success: true });
};

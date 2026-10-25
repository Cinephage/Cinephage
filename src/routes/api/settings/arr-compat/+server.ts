import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import { isArrCompatEnabled, setArrCompatEnabled } from '#lib/server/arr/arrCompatSettings.js';

const schema = z.object({ enabled: z.boolean() });

export const GET: RequestHandler = (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	return Response.json({ enabled: isArrCompatEnabled() });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const { enabled } = await parseBody(event.request, schema);
	setArrCompatEnabled(enabled);
	return Response.json({ enabled });
};

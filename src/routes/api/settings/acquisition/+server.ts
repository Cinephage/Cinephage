import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	getDefaultAcquisitionProtocol,
	setDefaultAcquisitionProtocol
} from '#lib/server/settings/acquisition.js';

const schema = z.object({ defaultAcquisitionProtocol: z.enum(['torrent', 'debrid']) });

export const GET: RequestHandler = (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	return Response.json({ defaultAcquisitionProtocol: getDefaultAcquisitionProtocol() });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const { defaultAcquisitionProtocol } = await parseBody(event.request, schema);
	setDefaultAcquisitionProtocol(defaultAcquisitionProtocol);
	return Response.json({ defaultAcquisitionProtocol });
};

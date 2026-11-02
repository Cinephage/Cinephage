import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	getSidecarSettings,
	setSidecarSettings
} from '#lib/server/library/sidecar/sidecarSettings.js';

const schema = z.object({
	enabled: z.boolean().optional(),
	overwriteExisting: z.boolean().optional(),
	includeArtwork: z.boolean().optional(),
	tvSeriesLevel: z.boolean().optional(),
	tvSeasonLevel: z.boolean().optional(),
	tvEpisodeLevel: z.boolean().optional()
});

export const GET: RequestHandler = (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	return Response.json(getSidecarSettings());
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const update = await parseBody(event.request, schema);
	setSidecarSettings(update);
	return Response.json(getSidecarSettings());
};

import { z } from 'zod';
import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseBody } from '#lib/server/api/validate.js';
import {
	getMetadataProviderConfig,
	setMetadataProviderConfig
} from '#lib/server/metadata/provider-settings.js';

const settingsSchema = z.object({
	animeEnrichmentEnabled: z.boolean().optional()
});

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const config = await getMetadataProviderConfig();
	return Response.json({ success: true, ...config });
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const parsed = await parseBody(event.request, settingsSchema);
	const config = await setMetadataProviderConfig(parsed);

	return Response.json({ success: true, ...config });
};

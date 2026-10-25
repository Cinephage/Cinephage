import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getSystemSettingsService } from '#lib/server/settings/SystemSettingsService.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'ExternalUrlSettingsApi', logDomain: 'system' });

const externalUrlSchema = z.object({
	url: z.string().url().nullable().or(z.literal(''))
});

export const PUT: RequestHandler = async (event) => {
	// Require admin authentication
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;

	try {
		const body = await request.json();
		const result = externalUrlSchema.safeParse(body);

		if (!result.success) {
			return Response.json({ error: 'Invalid URL format' }, { status: 400 });
		}

		const { url } = result.data;

		// A path component (e.g. https://proxy.example/cinephage) silently 404s on
		// every request once saved: the app has no base-path support anywhere
		// (SvelteKit's paths.base isn't configured), so a reverse proxy forwarding
		// a subpath has nowhere valid to route to. Reject up front with a clear
		// reason instead of accepting it and leaving the instance unreachable
		// through the proxy. See GitHub issue #596.
		if (url && new URL(url).pathname.replace(/\/+$/, '') !== '') {
			return Response.json(
				{
					error:
						'External URL must not include a path (e.g. "/cinephage") — subpath reverse-proxy routing is not currently supported. Use a dedicated (sub)domain instead.'
				},
				{ status: 400 }
			);
		}

		const settingsService = getSystemSettingsService();

		// If url is empty string, treat as null
		await settingsService.setExternalUrl(url || null);

		return Response.json({ success: true, url: url || null });
	} catch (error) {
		logger.error({ err: error, component: 'ExternalUrlApi' }, 'Error saving external URL');
		return Response.json({ error: 'Failed to save external URL' }, { status: 500 });
	}
};

export const GET: RequestHandler = async (event) => {
	// Require admin authentication
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const settingsService = getSystemSettingsService();
		const url = await settingsService.getExternalUrl();

		return Response.json({ url });
	} catch (error) {
		logger.error({ err: error, component: 'ExternalUrlApi' }, 'Error getting external URL');
		return Response.json({ error: 'Failed to get external URL' }, { status: 500 });
	}
};

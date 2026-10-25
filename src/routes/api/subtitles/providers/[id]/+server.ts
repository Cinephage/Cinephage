import type { RequestHandler } from './$types';
import { getSubtitleProviderManager } from '#lib/server/subtitles/services/SubtitleProviderManager.js';
import { subtitleProviderUpdateSchema } from '#lib/server/validation/schemas.js';
import { parseBody, assertFound } from '#lib/server/api/validate.js';

/**
 * GET /api/subtitles/providers/:id
 * Get a single subtitle provider by ID.
 */
export const GET: RequestHandler = async ({ params }) => {
	const manager = await getSubtitleProviderManager();
	const provider = assertFound(await manager.getProvider(params.id), 'Provider', params.id);

	// Redact sensitive fields
	return Response.json({
		...provider,
		apiKey: provider.apiKey ? '[REDACTED]' : null,
		password: provider.password ? '[REDACTED]' : null
	});
};

/**
 * PUT /api/subtitles/providers/:id
 * Update a subtitle provider.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	const validated = await parseBody(request, subtitleProviderUpdateSchema);
	const manager = await getSubtitleProviderManager();

	const updated = await manager.updateProvider(params.id, {
		name: validated.name,
		enabled: validated.enabled,
		priority: validated.priority,
		apiKey: validated.apiKey ?? undefined,
		username: validated.username ?? undefined,
		password: validated.password ?? undefined,
		settings: (validated.settings as Record<string, unknown>) ?? undefined,
		requestsPerMinute: validated.requestsPerMinute
	});

	return Response.json({ success: true, provider: updated });
};

/**
 * DELETE /api/subtitles/providers/:id
 * Delete a subtitle provider.
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const manager = await getSubtitleProviderManager();
	await manager.deleteProvider(params.id);
	return Response.json({ success: true });
};

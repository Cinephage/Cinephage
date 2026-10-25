import type { RequestHandler } from './$types';
import { getSubtitleProviderManager } from '#lib/server/subtitles/services/SubtitleProviderManager.js';
import { getSubtitleProviderFactory } from '#lib/server/subtitles/providers/SubtitleProviderFactory.js';
import { ensureProvidersRegistered } from '#lib/server/subtitles/providers/registry.js';
import { subtitleProviderCreateSchema } from '#lib/server/validation/schemas.js';
import { parseBody } from '#lib/server/api/validate.js';

/**
 * GET /api/subtitles/providers
 * List all configured subtitle providers.
 * Note: API keys and passwords are redacted for security.
 */
export const GET: RequestHandler = async () => {
	// Ensure providers are registered
	await ensureProvidersRegistered();

	const manager = getSubtitleProviderManager();
	const providers = await manager.getProviders();

	// Redact sensitive fields
	const redactedProviders = providers.map((provider) => ({
		...provider,
		apiKey: provider.apiKey ? '[REDACTED]' : null,
		password: provider.password ? '[REDACTED]' : null,
		settings: provider.settings
			? Object.fromEntries(
					Object.entries(provider.settings).map(([key, value]) => {
						const lowerKey = key.toLowerCase();
						if (
							lowerKey.includes('key') ||
							lowerKey.includes('password') ||
							lowerKey.includes('secret') ||
							lowerKey.includes('token')
						) {
							return [key, value ? '[REDACTED]' : null];
						}
						return [key, value];
					})
				)
			: null
	}));

	return Response.json(redactedProviders);
};

/**
 * POST /api/subtitles/providers
 * Create a new subtitle provider.
 */
export const POST: RequestHandler = async ({ request }) => {
	const validated = await parseBody(request, subtitleProviderCreateSchema);
	const manager = await getSubtitleProviderManager();

	// Verify the implementation is supported
	await ensureProvidersRegistered();
	const factory = getSubtitleProviderFactory();
	const definition = factory.getDefinition(validated.implementation);
	if (!definition) {
		return Response.json(
			{
				error: 'Invalid implementation',
				details: `Unknown provider implementation: ${validated.implementation}`
			},
			{ status: 400 }
		);
	}

	const created = await manager.createProvider({
		name: validated.name,
		implementation: validated.implementation,
		enabled: validated.enabled,
		priority: validated.priority,
		apiKey: validated.apiKey ?? undefined,
		username: validated.username ?? undefined,
		password: validated.password ?? undefined,
		settings: (validated.settings as Record<string, unknown>) ?? undefined,
		requestsPerMinute: validated.requestsPerMinute
	});

	return Response.json({ success: true, provider: created });
};

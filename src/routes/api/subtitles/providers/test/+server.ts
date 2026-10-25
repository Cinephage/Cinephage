import type { RequestHandler } from './$types';
import { subtitleProviderTestSchema } from '#lib/server/validation/schemas.js';
import { getSubtitleProviderFactory } from '#lib/server/subtitles/providers/SubtitleProviderFactory.js';
import { ensureProvidersRegistered } from '#lib/server/subtitles/providers/registry.js';
import { parseBody } from '#lib/server/api/validate.js';

/**
 * POST /api/subtitles/providers/test
 * Test a subtitle provider configuration.
 */
export const POST: RequestHandler = async ({ request }) => {
	// Ensure providers are registered
	await ensureProvidersRegistered();

	const validated = await parseBody(request, subtitleProviderTestSchema);
	const factory = getSubtitleProviderFactory();

	// Create a temporary provider config for testing
	const testConfig = {
		id: 'test',
		name: 'Test Provider',
		implementation: validated.implementation,
		enabled: true,
		priority: 1,
		apiKey: validated.apiKey ?? undefined,
		username: validated.username ?? undefined,
		password: validated.password ?? undefined,
		settings: (validated.settings as Record<string, unknown>) ?? undefined,
		requestsPerMinute: 60,
		consecutiveFailures: 0
	};

	const provider = factory.createProvider(testConfig);
	const testResult = await provider.test();

	return Response.json({
		success: testResult.success,
		message: testResult.message,
		responseTime: testResult.responseTime
	});
};

/**
 * POST /api/usenet/servers/test - Test NNTP connection without saving
 */

import type { RequestHandler } from './$types';
import { nntpServerTestSchema } from '#lib/validation/schemas.js';
import { testNntpConnection } from '#lib/server/streaming/nzb/NntpTestUtils.js';
import { logger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

/**
 * POST /api/usenet/servers/test
 * Test NNTP connection with provided credentials (without saving).
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = nntpServerTestSchema.safeParse(data);

	if (!result.success) {
		return Response.json(
			{
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const { host, port, useSsl, username, password } = result.data;

	logger.info({ host, port, useSsl }, '[NNTP Test] Testing connection');

	const testResult = await testNntpConnection(host, port, useSsl ?? true, username, password);

	if (testResult.success) {
		logger.info({ host, greeting: testResult.greeting }, '[NNTP Test] Connection successful');
		return Response.json({
			success: true,
			greeting: testResult.greeting
		});
	} else {
		logger.warn({ host, error: testResult.error }, '[NNTP Test] Connection failed');
		return Response.json(
			{
				success: false,
				error: testResult.error
			},
			{ status: 400 }
		);
	}
};

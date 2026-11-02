/**
 * POST /api/usenet/servers/:id/test - Test NNTP server connection
 */

import type { RequestHandler } from './$types';
import { getNntpServerService } from '#lib/server/streaming/nzb/NntpServerService.js';
import { testNntpConnection } from '#lib/server/streaming/nzb/NntpTestUtils.js';
import { logger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

/**
 * POST /api/usenet/servers/:id/test
 * Test NNTP server connection using stored credentials.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params } = event;
	const service = getNntpServerService();
	const server = await service.getServerWithPassword(params.id);

	if (!server) {
		return Response.json({ error: 'Server not found' }, { status: 404 });
	}

	logger.info(
		{
			id: server.id,
			host: server.host,
			port: server.port,
			useSsl: server.useSsl
		},
		'[NNTP Test] Testing connection'
	);

	const result = await testNntpConnection(
		server.host,
		server.port,
		server.useSsl ?? true,
		server.username,
		server.password
	);

	// Update test result in database
	await service.updateTestResult(server.id, result.success ? 'success' : 'failed', result.error);

	if (result.success) {
		logger.info({ id: server.id, greeting: result.greeting }, '[NNTP Test] Connection successful');
		return Response.json({
			success: true,
			greeting: result.greeting
		});
	} else {
		logger.warn({ id: server.id, error: result.error }, '[NNTP Test] Connection failed');
		return Response.json(
			{
				success: false,
				error: result.error
			},
			{ status: 400 }
		);
	}
};

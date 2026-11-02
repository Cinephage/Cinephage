import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { logHistoryService } from '#lib/server/logging/log-history.js';
import { logHistoryQuerySchema } from '#lib/validation/schemas.js';

const logger = createChildLogger({ module: 'LogHistoryApi', logDomain: 'system' });

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const raw = Object.fromEntries(event.url.searchParams.entries());
	const parsed = logHistoryQuerySchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{
				success: false,
				error: 'Validation failed',
				details: parsed.error.flatten()
			},
			{ status: 400 }
		);
	}

	try {
		const result = await logHistoryService.search(parsed.data);
		return Response.json({ success: true, ...result });
	} catch (error) {
		logger.error({ err: error }, 'Failed to load log history');
		return Response.json({ success: false, error: 'Failed to load log history' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		await logHistoryService.clearAllFiles();
		return Response.json({ success: true });
	} catch (error) {
		logger.error({ err: error }, 'Failed to clear log history');
		return Response.json({ success: false, error: 'Failed to clear log history' }, { status: 500 });
	}
};

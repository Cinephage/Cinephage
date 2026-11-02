import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getReconciliationService } from '#lib/server/storage/reconciliation/ReconciliationService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { RequestHandler } from './$types';

const logger = createChildLogger({ logDomain: 'system' as const });

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	setImmediate(() => {
		getReconciliationService()
			.reconcile()
			.catch((err) => {
				logger.error('[api/storage/reconcile] failed', err);
			});
	});

	return Response.json({ success: true, message: 'Reconciliation triggered' }, { status: 202 });
};

import type { RequestHandler } from './$types.js';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryReconcileApi', logDomain: 'scans' });

/**
 * POST /api/library/reconcile
 * Run library <-> root folder reconciliation manually.
 *
 * This is the runEndpoint for the 'library-reconcile' scheduled task in
 * UnifiedTaskRegistry. The scheduler invokes it on its configured interval
 * (default 6 hours). Admins can also trigger it via the Tasks settings page.
 *
 * Reconciliation heals drift between libraries, root folders, and their
 * join-table assignments. It runs:
 *   - backfillLibraryRootFolders (seed missing default assignments)
 *   - syncSystemLibrariesFromRootFolders (reconcile system libraries +
 *     root folder assignments)
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const startedAt = Date.now();
	logger.info('[/api/library/reconcile] Starting manual reconciliation');

	try {
		const result = await monitoringScheduler.runLibraryReconcile();
		const durationMs = Date.now() - startedAt;
		logger.info({ durationMs }, '[/api/library/reconcile] Completed');
		return Response.json({ success: true, durationMs, result });
	} catch (err) {
		logger.error({ err }, '[/api/library/reconcile] Failed');
		return Response.json(
			{ success: false, error: err instanceof Error ? err.message : 'Reconciliation failed' },
			{ status: 500 }
		);
	}
};

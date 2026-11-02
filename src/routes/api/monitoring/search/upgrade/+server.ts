import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { monitoringSearchService } from '#lib/server/monitoring/search/MonitoringSearchService.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'MonitoringSearchUpgradeApi', logDomain: 'monitoring' });

/**
 * POST /api/monitoring/search/upgrade
 * Manually trigger upgrade search
 *
 * Query params:
 * - dryRun=true: Simulate the search without grabbing. Logs what would happen and returns detailed upgrade decisions.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { url } = event;
	const dryRun = url.searchParams.get('dryRun') === 'true';

	try {
		if (dryRun) {
			// Dry-run mode: simulate the search without grabbing
			logger.info('[API] Starting upgrade search dry-run');

			const results = await monitoringSearchService.searchForUpgrades({
				cutoffUnmetOnly: false,
				dryRun: true
			});

			return Response.json({
				success: true,
				message: 'Upgrade search dry-run completed (no grabs performed)',
				dryRun: true,
				summary: results.summary,
				items: results.items,
				upgradeDetails: results.upgradeDetails
			});
		}

		// Normal mode: actually grab upgrades
		const result = await monitoringScheduler.runUpgradeSearch();

		return Response.json({
			success: true,
			message: 'Upgrade search completed',
			result
		});
	} catch (error) {
		logger.error('[API] Failed to run upgrade search', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: 'Failed to run upgrade search',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};

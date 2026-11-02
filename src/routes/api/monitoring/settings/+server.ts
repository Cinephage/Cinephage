import type { RequestHandler } from './$types';
import { monitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { monitoringSettingsUpdateSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'MonitoringSettingsApi', logDomain: 'monitoring' });

/**
 * GET /api/monitoring/settings
 * Returns current monitoring settings and status
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		// Get both status and settings
		const status = await monitoringScheduler.getStatus();
		const fullSettings = await monitoringScheduler.getSettings();

		return Response.json({
			success: true,
			settings: {
				missingSearchIntervalHours: status.tasks.missing.intervalHours,
				upgradeSearchIntervalHours: status.tasks.upgrade.intervalHours,
				newEpisodeCheckIntervalHours: status.tasks.newEpisode.intervalHours,
				cutoffUnmetSearchIntervalHours: status.tasks.cutoffUnmet.intervalHours,
				stalledDownloadTimeoutMinutes: fullSettings.stalledDownloadTimeoutMinutes,
				stalledDownloadProgressThreshold: fullSettings.stalledDownloadProgressThreshold,
				stalledDownloadBlocklistHours: fullSettings.stalledDownloadBlocklistHours
			},
			status: {
				tasks: status.tasks
			}
		});
	} catch (error) {
		logger.error(
			'[API] Failed to get monitoring settings',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to get monitoring settings'
			},
			{ status: 500 }
		);
	}
};

/**
 * PUT /api/monitoring/settings
 * Update monitoring settings
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		const body = await request.json();
		const validation = monitoringSettingsUpdateSchema.safeParse(body);

		if (!validation.success) {
			return Response.json(
				{
					success: false,
					error: 'Invalid request body',
					details: validation.error.issues
				},
				{ status: 400 }
			);
		}

		const settings = validation.data;

		// Update settings
		await monitoringScheduler.updateSettings(settings);

		// Get updated status
		const status = await monitoringScheduler.getStatus();
		const fullUpdatedSettings = await monitoringScheduler.getSettings();

		return Response.json({
			success: true,
			message: 'Monitoring settings updated',
			settings: {
				missingSearchIntervalHours: status.tasks.missing.intervalHours,
				upgradeSearchIntervalHours: status.tasks.upgrade.intervalHours,
				newEpisodeCheckIntervalHours: status.tasks.newEpisode.intervalHours,
				cutoffUnmetSearchIntervalHours: status.tasks.cutoffUnmet.intervalHours,
				stalledDownloadTimeoutMinutes: fullUpdatedSettings.stalledDownloadTimeoutMinutes,
				stalledDownloadProgressThreshold: fullUpdatedSettings.stalledDownloadProgressThreshold,
				stalledDownloadBlocklistHours: fullUpdatedSettings.stalledDownloadBlocklistHours
			},
			status: {
				tasks: status.tasks
			}
		});
	} catch (error) {
		logger.error(
			'[API] Failed to update monitoring settings',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to update monitoring settings'
			},
			{ status: 500 }
		);
	}
};

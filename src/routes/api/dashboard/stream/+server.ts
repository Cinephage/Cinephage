import { createSSEStream } from '#lib/server/sse.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { librarySchedulerService } from '#lib/server/library/library-scheduler.js';
import { diskScanService } from '#lib/server/library/disk-scan.js';
import { logger } from '#lib/logging/index.js';
import { activityService } from '#lib/server/activity/index.js';
import {
	getDashboardStats,
	getRecentlyAdded,
	getMissingEpisodes
} from '#lib/server/dashboard/queries.js';
import type { RequestHandler } from '@sveltejs/kit';

/**
 * Server-Sent Events endpoint for real-time dashboard updates
 *
 * The client receives initial data from the page server load function,
 * so this stream does NOT send an initial state dump. It only sends
 * incremental updates triggered by real events (downloads, scans, etc).
 *
 * Events emitted:
 * - dashboard:stats - Stats update (triggered by library changes)
 * - dashboard:recentlyAdded - Recently added content update
 * - dashboard:missingEpisodes - Missing episodes update
 * - dashboard:recentActivity - Recent history update
 */
export const GET: RequestHandler = async () => {
	return createSSEStream((send) => {
		let historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

		// Send updated dashboard data (stats, recentlyAdded, missingEpisodes)
		const sendDashboardUpdate = async () => {
			try {
				const [stats, recentlyAdded, missingEpisodes] = await Promise.all([
					getDashboardStats(),
					getRecentlyAdded(),
					getMissingEpisodes()
				]);

				send('dashboard:stats', stats);
				send('dashboard:recentlyAdded', recentlyAdded);
				send('dashboard:missingEpisodes', missingEpisodes);
			} catch (error) {
				logger.error(
					{ err: error, component: 'DashboardStream', logDomain: 'http' },
					'[DashboardStream] Failed to fetch dashboard update'
				);
			}
		};

		const sendRecentHistory = async () => {
			try {
				const { activities } = await activityService.getActivities(
					{ status: 'all', mediaType: 'all', protocol: 'all' },
					{ field: 'time', direction: 'desc' },
					{ limit: 18, offset: 0 },
					'history'
				);

				send('dashboard:recentActivity', activities);
			} catch (error) {
				logger.error(
					{ err: error, component: 'DashboardStream', logDomain: 'http' },
					'[DashboardStream] Failed to fetch recent history'
				);
			}
		};

		const scheduleRecentHistoryRefresh = (delayMs = 250) => {
			if (historyRefreshTimer !== null) {
				clearTimeout(historyRefreshTimer);
			}

			historyRefreshTimer = setTimeout(() => {
				historyRefreshTimer = null;
				void sendRecentHistory();
			}, delayMs);
		};

		// No initial state sent - client already has data from page server load

		// Send initial activity data when client connects
		(async () => {
			await sendRecentHistory();
		})();

		// Event handlers for download monitor
		const onQueueImported = async () => {
			scheduleRecentHistoryRefresh();
			// Update dashboard data
			await sendDashboardUpdate();
		};

		const onQueueFailed = async () => {
			scheduleRecentHistoryRefresh();
		};

		// Library scheduler events
		const onScanComplete = async () => {
			await sendDashboardUpdate();
		};

		// Disk scan events
		const onScanProgress = (progress: unknown) => {
			send('dashboard:scanProgress', progress);
		};

		// Register handlers
		downloadMonitor.on('queue:imported', onQueueImported);
		downloadMonitor.on('queue:failed', onQueueFailed);
		librarySchedulerService.on('scanComplete', onScanComplete);
		diskScanService.on('progress', onScanProgress);

		// Return cleanup function
		return () => {
			if (historyRefreshTimer !== null) clearTimeout(historyRefreshTimer);
			downloadMonitor.off('queue:imported', onQueueImported);
			downloadMonitor.off('queue:failed', onQueueFailed);
			librarySchedulerService.off('scanComplete', onScanComplete);
			diskScanService.off('progress', onScanProgress);
		};
	});
};

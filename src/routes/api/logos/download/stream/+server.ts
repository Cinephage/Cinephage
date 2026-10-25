import type { RequestHandler } from './$types';
import { createSSEStream } from '#lib/server/sse.js';
import { getLogoDownloadService } from '#lib/server/logos/LogoDownloadService.js';
import type { LogoDownloadProgress } from '#lib/server/logos/LogoDownloadService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LogosDownloadStreamApi', logDomain: 'system' });

/**
 * GET /api/logos/download/stream
 * SSE endpoint for real-time logo download progress
 */
export const GET: RequestHandler = async () => {
	const service = getLogoDownloadService();

	return createSSEStream((send) => {
		// First, register ALL event listeners BEFORE doing anything else
		// This prevents missing events that fire during setup

		const onStarted = (data: LogoDownloadProgress) => {
			logger.info(
				{
					total: data.total,
					status: data.status
				},
				'[LogoDownloadStream] Download started event'
			);
			send('logos:started', data);
		};

		const onProgress = (data: LogoDownloadProgress) => {
			send('logos:progress', data);
		};

		const onCompleted = (data: LogoDownloadProgress) => {
			logger.info(
				{
					downloaded: data.downloaded,
					total: data.total
				},
				'[LogoDownloadStream] Download completed event'
			);
			send('logos:completed', data);
		};

		const onError = (data: LogoDownloadProgress) => {
			logger.error(
				{
					error: data.error
				},
				'[LogoDownloadStream] Download error event'
			);
			send('logos:error', data);
		};

		// Register listeners FIRST
		service.on('started', onStarted);
		service.on('progress', onProgress);
		service.on('completed', onCompleted);
		service.on('error', onError);

		// NOW get and send current status (after listeners are registered)
		const currentStatus: LogoDownloadProgress = service.progress;
		logger.info(
			{
				status: currentStatus.status,
				downloaded: currentStatus.downloaded,
				total: currentStatus.total
			},
			'[LogoDownloadStream] Client connected, sending status'
		);
		send('logos:status', currentStatus);

		// Return cleanup function
		return () => {
			service.off('started', onStarted);
			service.off('progress', onProgress);
			service.off('completed', onCompleted);
			service.off('error', onError);
		};
	});
};

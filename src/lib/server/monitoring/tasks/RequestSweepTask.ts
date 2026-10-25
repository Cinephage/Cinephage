/**
 * Request Sweep Task
 *
 * Hourly maintenance for the request system: expires stale pending
 * requests (TTL), re-drives awaiting-target approvals when a writable
 * target may have appeared, and re-evaluates active requests against
 * library truth (covers event-less mutation paths such as manual imports
 * and unmatched-file matching).
 */

import { getRequestAvailabilityProjector } from '#lib/server/requests/RequestAvailabilityProjector.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'RequestSweepTask', logDomain: 'monitoring' });

export async function executeRequestSweepTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	logger.info('[RequestSweepTask] Starting request sweep');

	try {
		ctx?.checkCancelled();

		const result = await getRequestAvailabilityProjector().runSweep();

		ctx?.checkCancelled();

		logger.info(result, '[RequestSweepTask] Sweep completed');

		return {
			taskType: 'request-sweep',
			itemsProcessed:
				result.expired +
				result.fulfilledAdvanced +
				result.targetRetries +
				result.orphanedFailed +
				result.notificationsPruned,
			itemsGrabbed: 0,
			errors: 0,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[RequestSweepTask] Sweep failed');
		throw error;
	}
}

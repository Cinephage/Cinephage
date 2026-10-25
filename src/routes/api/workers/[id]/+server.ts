/**
 * Worker API - Individual worker operations
 *
 * GET /api/workers/[id] - Get worker details and logs
 * DELETE /api/workers/[id] - Cancel/remove a worker
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { workerManager } from '#lib/server/workers/index.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const { id } = params;
	const logsLimit = parseInt(url.searchParams.get('logs') || '100', 10);

	const worker = workerManager.get(id);

	if (!worker) {
		throw error(404, 'Worker not found');
	}

	return Response.json({
		...worker.getState(),
		logs: workerManager.getLogs(id, logsLimit)
	});
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	const { id } = params;
	const force = url.searchParams.get('force') === 'true';

	const worker = workerManager.get(id);

	if (!worker) {
		throw error(404, 'Worker not found');
	}

	if (worker.isActive && !force) {
		// Cancel the worker first
		const cancelled = workerManager.cancel(id);
		return Response.json({
			success: cancelled,
			action: 'cancelled',
			message: cancelled ? 'Worker cancelled' : 'Failed to cancel worker'
		});
	}

	// Remove the worker
	const removed = workerManager.remove(id);
	return Response.json({
		success: removed,
		action: 'removed',
		message: removed ? 'Worker removed' : 'Failed to remove worker'
	});
};

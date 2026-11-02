/**
 * Workers API - List and manage workers
 *
 * GET /api/workers - List all workers (optionally filter by type)
 * DELETE /api/workers - Clear all completed workers
 */

import type { RequestHandler } from './$types';
import { workerManager } from '#lib/server/workers/index.js';
import type { WorkerType } from '#lib/server/workers/index.js';

export const GET: RequestHandler = async ({ url }) => {
	const typeParam = url.searchParams.get('type') as WorkerType | null;
	const activeOnly = url.searchParams.get('active') === 'true';

	let workers = workerManager.listStates(typeParam || undefined);

	if (activeOnly) {
		workers = workers.filter((w) => w.status === 'pending' || w.status === 'running');
	}

	const stats = workerManager.getStats();

	return Response.json({
		workers,
		stats,
		config: workerManager.getConfig()
	});
};

export const DELETE: RequestHandler = async () => {
	const cleared = workerManager.clearCompleted();

	return Response.json({
		success: true,
		cleared
	});
};

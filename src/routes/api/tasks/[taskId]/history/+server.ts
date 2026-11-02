/**
 * Task History API
 *
 * GET /api/tasks/[taskId]/history - Returns execution history for a specific task
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUnifiedTaskById } from '#lib/server/tasks/UnifiedTaskRegistry.js';
import { taskHistoryService } from '#lib/server/tasks/TaskHistoryService.js';
import { z } from 'zod';

const querySchema = z.object({
	limit: z.coerce.number().int().positive().max(100).default(10),
	offset: z.coerce.number().int().nonnegative().default(0)
});

/**
 * GET /api/tasks/[taskId]/history
 *
 * Returns paginated execution history for a specific task.
 *
 * Query params:
 * - limit: Number of entries to return (default: 10, max: 100)
 * - offset: Number of entries to skip (default: 0)
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const { taskId } = params;

	// Verify task exists
	const task = getUnifiedTaskById(taskId);
	if (!task) {
		throw error(404, `Task '${taskId}' not found`);
	}

	// Parse query params
	const parseResult = querySchema.safeParse({
		limit: url.searchParams.get('limit') ?? undefined,
		offset: url.searchParams.get('offset') ?? undefined
	});

	if (!parseResult.success) {
		throw error(400, 'Invalid query parameters');
	}

	const { limit, offset } = parseResult.data;

	// Get history for this task
	const { entries, total } = await taskHistoryService.getHistoryForTask(taskId, limit, offset);

	return Response.json({
		success: true,
		taskId,
		history: entries,
		pagination: {
			limit,
			offset,
			total,
			hasMore: offset + entries.length < total
		}
	});
};

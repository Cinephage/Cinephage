/**
 * Match Streamed Music Task
 *
 * Walks the stream-backed library and gives every track a remembered provider
 * upload, so the first play of any album costs one resolve instead of a search
 * plus a resolve — and the same upload plays every time. Nothing is downloaded:
 * the pass writes the upload id the resolver already stores, and that is all.
 *
 * Free once done: a matched library causes no provider calls at all.
 */

import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';
import { matchStreamedMusic } from '#lib/server/music/MusicStreamMatch.js';

const logger = createChildLogger({ module: 'MusicStreamMatchTask', logDomain: 'monitoring' });

export async function executeMusicStreamMatchTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	logger.info('[MusicStreamMatchTask] Starting streamed music match');

	ctx?.checkCancelled();

	const { summary } = await matchStreamedMusic(ctx);

	logger.info({ ...summary }, '[MusicStreamMatchTask] Streamed music match finished');

	return {
		taskType: 'music-stream-match',
		itemsProcessed: summary.matched,
		itemsGrabbed: 0,
		errors: summary.unresolved,
		executedAt
	};
}

/**
 * POST /api/queue/unmatched/enroll
 *
 * Enrolls a wizard-matched unmatched download for monitor-driven import.
 * Used when the torrent's files live inside a managed root, where the
 * wizard cannot execute the import itself. Creates a normal tracked row at
 * the mirrored live status; the monitor's ImportService moves the files on
 * completion. Idempotent.
 */
import type { RequestHandler } from './$types';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { handleUnmatchedPost, enrollBodySchema } from '../shared.js';

export const POST: RequestHandler = async (event) =>
	handleUnmatchedPost(event, {
		logModule: 'QueueUnmatchedEnrollApi',
		verb: 'enrolled',
		schema: enrollBodySchema,
		run: (pairs) => downloadMonitor.enrollUnmatchedDownloads(pairs)
	});

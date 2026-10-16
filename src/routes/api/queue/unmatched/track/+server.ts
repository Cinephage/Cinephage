/**
 * POST /api/queue/unmatched/track
 *
 * Records queue tracking for an unmatched download AFTER the import wizard
 * imported its files. Single path: the wizard's match (mediaType + TMDB id)
 * resolves the library row server-side. Pairs for media with no library
 * file, or for still-downloading torrents, are rejected — callers must only
 * invoke it for complete downloads of file-backed media. Idempotent.
 */
import type { RequestHandler } from './$types';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { handleUnmatchedPost, trackBodySchema } from '../shared.js';

export const POST: RequestHandler = async (event) =>
	handleUnmatchedPost(event, {
		logModule: 'QueueUnmatchedTrackApi',
		verb: 'tracked',
		schema: trackBodySchema,
		run: (pairs) => downloadMonitor.trackUnmatchedDownloads(pairs)
	});

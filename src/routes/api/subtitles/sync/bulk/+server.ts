import type { RequestHandler } from './$types';
import { getSubtitleSyncService } from '#lib/server/subtitles/services/SubtitleSyncService.js';
import { subtitleBulkSyncSchema } from '#lib/validation/schemas.js';

/**
 * POST /api/subtitles/sync/bulk
 * Sync multiple subtitles with limited concurrency (2 parallel).
 * Returns NDJSON stream with per-subtitle results for live progress.
 */
export const POST: RequestHandler = async ({ request }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = subtitleBulkSyncSchema.safeParse(data);

	if (!result.success) {
		return Response.json(
			{
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const { subtitleIds, splitPenalty, noSplits } = result.data;
	const syncService = getSubtitleSyncService();
	const total = subtitleIds.length;
	const CONCURRENCY = 2;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			function emit(payload: {
				subtitleId: string;
				success: boolean;
				offsetMs: number;
				error?: string;
				index: number;
				total: number;
			}) {
				controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'));
			}

			// Process with limited concurrency
			let nextIndex = 0;

			async function processOne(): Promise<void> {
				while (nextIndex < total) {
					const currentIndex = nextIndex++;
					const subtitleId = subtitleIds[currentIndex];

					try {
						const syncResult = await syncService.syncSubtitle(subtitleId, {
							splitPenalty,
							noSplits
						});

						emit({
							subtitleId,
							success: syncResult.success,
							offsetMs: syncResult.offsetMs,
							error: syncResult.error,
							index: currentIndex,
							total
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : 'Unknown error';
						emit({
							subtitleId,
							success: false,
							offsetMs: 0,
							error: message,
							index: currentIndex,
							total
						});
					}
				}
			}

			try {
				// Launch workers up to CONCURRENCY limit
				const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => processOne());
				await Promise.all(workers);
			} catch {
				// Stream errors are handled per-subtitle above
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/x-ndjson',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};

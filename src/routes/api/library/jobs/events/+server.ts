import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createSSEStream } from '#lib/server/sse.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const url = new URL(event.request.url);
	const jobId = url.searchParams.get('jobId');
	const wantsSSE = event.request.headers.get('accept')?.includes('text/event-stream');

	if (!wantsSSE) {
		const payload = jobId
			? await libraryJobService.getJob(jobId)
			: await libraryJobService.listActiveJobs();
		return Response.json({ success: true, data: payload });
	}

	return createSSEStream(async (send) => {
		let closed = false;
		async function publish() {
			const payload = jobId
				? await libraryJobService.getJob(jobId)
				: await libraryJobService.listActiveJobs();
			send('jobs', payload);
		}
		await publish();
		const interval = setInterval(() => {
			if (!closed) void publish();
		}, 2000);
		return () => {
			closed = true;
			clearInterval(interval);
		};
	});
};

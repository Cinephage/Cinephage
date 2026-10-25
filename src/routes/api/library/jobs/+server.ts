import type { RequestHandler } from './$types.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';
import { LIBRARY_JOB_TYPES, LIBRARY_JOB_STATUSES } from '#lib/server/library/jobs/types.js';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const url = new URL(event.request.url);
	const parentJobId = url.searchParams.get('parentJobId') ?? undefined;
	// A parentJobId query is a bounded lookup of one specific bulk-import
	// batch (up to MAX_BULK_IMPORT_JOBS groups), not a general listing: allow
	// a much higher cap there than the default "recent activity" query.
	const maxLimit = parentJobId ? 5000 : 100;
	const limit = Math.min(maxLimit, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
	const typeParam = url.searchParams.get('type');
	const statusParam = url.searchParams.get('status');

	const type = LIBRARY_JOB_TYPES.find((t) => t === typeParam);
	const status = LIBRARY_JOB_STATUSES.find((s) => s === statusParam);

	const jobs = await libraryJobService.listJobs({ type, status, parentJobId, limit });
	return Response.json({ success: true, jobs });
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;
	const body = await event.request.json().catch(() => ({}));
	if (body.type === 'scan_root_folder' && typeof body.rootFolderId === 'string') {
		const job = await libraryJobService.enqueueRootFolderScan(body.rootFolderId);
		return Response.json({ success: true, job });
	}
	if (body.type === 'scan_all_root_folders') {
		const job = await libraryJobService.enqueueFullScan();
		return Response.json({ success: true, job });
	}
	return Response.json({ success: false, error: 'Unsupported job type' }, { status: 400 });
};

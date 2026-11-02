import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { libraryScanHistory, rootFolders } from '#lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';
import { diskScanService } from '#lib/server/library/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { parseOptionalBody } from '#lib/server/api/validate.js';
import { libraryScanSchema } from '#lib/validation/schemas.js';

/**
 * GET /api/library/scan
 * Get scan history
 */
export const GET: RequestHandler = async ({ url }) => {
	const limit = parseInt(url.searchParams.get('limit') || '20', 10);
	const rootFolderId = url.searchParams.get('rootFolderId');

	const query = db
		.select({
			id: libraryScanHistory.id,
			rootFolderId: libraryScanHistory.rootFolderId,
			rootFolderPath: rootFolders.path,
			scanType: libraryScanHistory.scanType,
			status: libraryScanHistory.status,
			filesScanned: libraryScanHistory.filesScanned,
			filesAdded: libraryScanHistory.filesAdded,
			filesUpdated: libraryScanHistory.filesUpdated,
			filesRemoved: libraryScanHistory.filesRemoved,
			unmatchedFiles: libraryScanHistory.unmatchedFiles,
			errorMessage: libraryScanHistory.errorMessage,
			startedAt: libraryScanHistory.startedAt,
			completedAt: libraryScanHistory.completedAt
		})
		.from(libraryScanHistory)
		.leftJoin(rootFolders, eq(libraryScanHistory.rootFolderId, rootFolders.id))
		.orderBy(desc(libraryScanHistory.startedAt))
		.limit(limit);

	const history = rootFolderId
		? await query.where(eq(libraryScanHistory.rootFolderId, rootFolderId))
		: await query;

	return Response.json({
		success: true,
		history
	});
};

/**
 * POST /api/library/scan
 * Trigger a manual scan
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	const body = await parseOptionalBody(request, libraryScanSchema);
	const { rootFolderId, fullScan } = body;

	// If the disk scanner is idle, reset any jobs still marked 'running' in the
	// DB so they can be re-queued. This is a recovery mechanism for when the server
	// is restarted while a scan is in progress. If the disk scanner is already
	// running, we don't want to reset jobs because they are actively being processed.
	if (!diskScanService.scanning) {
		libraryJobService.recoverInterruptedJobs();
	}

	if (rootFolderId) {
		const job = await libraryJobService.enqueueRootFolderScan(rootFolderId);
		return Response.json({
			success: true,
			message: `Scan queued for root folder ${rootFolderId}`,
			jobId: job.id,
			status: job.status
		});
	} else if (fullScan) {
		const job = await libraryJobService.enqueueFullScan();
		return Response.json({
			success: true,
			message: 'Full library scan queued',
			jobId: job.id,
			status: job.status
		});
	} else {
		const job = await libraryJobService.enqueueFullScan();
		return Response.json({
			success: true,
			message: 'Library scan queued',
			jobId: job.id,
			status: job.status
		});
	}
};

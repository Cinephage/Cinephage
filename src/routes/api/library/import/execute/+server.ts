import type { RequestHandler } from './$types.js';
import { manualImportSchema } from '#lib/validation/schemas.js';
import { manualImportService } from '#lib/server/library/manual-import-service.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';
import { isPathAllowed, isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryImportExecuteApi', logDomain: 'scans' });

function getExecuteErrorMessage(error: unknown): string {
	const fsError = error as NodeJS.ErrnoException;
	if (fsError?.code === 'ENOENT') {
		return 'Selected path no longer exists. Please choose it again.';
	}

	if (fsError?.code === 'EACCES' || fsError?.code === 'EPERM') {
		return 'Permission denied while importing from this path.';
	}

	return error instanceof Error ? error.message : 'Failed to import file';
}

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		let body: unknown;
		try {
			body = await request.json();
		} catch (error) {
			// adapter-node aborts the request stream when the body exceeds
			// BODY_SIZE_LIMIT, surfacing here as a 413 Payload Too Large.
			const status = (error as { status?: number } | null)?.status;
			if (status === 413) {
				return Response.json(
					{ success: false, error: 'Request payload too large' },
					{ status: 413 }
				);
			}
			return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
		}

		const parsed = manualImportSchema.safeParse(body);
		if (!parsed.success) {
			return Response.json(
				{
					success: false,
					error: 'Validation failed',
					details: parsed.error.flatten()
				},
				{ status: 400 }
			);
		}

		const payload = parsed.data;
		const importPath = payload.sourcePath ?? payload.selectedFilePath;

		if (!importPath || !(await isPathAllowed(importPath))) {
			return Response.json(
				{
					success: false,
					error: 'Access denied: Path is outside allowed directories'
				},
				{ status: 403 }
			);
		}
		if (await isPathInsideManagedRoot(importPath)) {
			return Response.json(
				{
					success: false,
					error: 'Import source cannot be inside a managed root folder.'
				},
				{ status: 400 }
			);
		}

		// Background mode (#530): enqueue a durable library job and return
		// immediately; the worker runs the import and reports progress over the
		// standard library-jobs endpoints.
		if (payload.background) {
			const job = libraryJobService.enqueueJob({
				type: 'manual_import',
				dedupeKey: `manual_import:${importPath}:${payload.tmdbId}:${payload.libraryId ?? 'new'}`,
				metadata: { request: payload }
			});
			return Response.json(
				{ success: true, data: { jobId: job.id, background: true } },
				{ status: 202 }
			);
		}

		const result = await manualImportService.executeImport(payload);
		libraryMediaEvents.emitLibraryDataChanged({
			source: payload.mediaType === 'tv' ? 'series' : 'movie',
			reason: 'manual-import'
		});
		return Response.json({ success: true, data: result });
	} catch (error) {
		logger.error('[API] Manual import execute failed', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: getExecuteErrorMessage(error)
			},
			{ status: 500 }
		);
	}
};

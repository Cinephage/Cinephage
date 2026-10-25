import { randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types.js';
import { z } from 'zod';
import { manualImportSchema } from '#lib/validation/schemas.js';
import { libraryJobService } from '#lib/server/library/jobs/LibraryJobService.js';
import { isPathAllowed, isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { MAX_BULK_IMPORT_JOBS } from '#lib/shared/bulk-import.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryImportBulkApi', logDomain: 'scans' });

const bulkSchema = z.object({
	jobs: z
		.array(
			z.object({
				request: manualImportSchema,
				groupName: z.string().optional()
			})
		)
		.min(1)
		.max(MAX_BULK_IMPORT_JOBS)
});

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

		const parsed = bulkSchema.safeParse(body);
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

		for (const job of parsed.data.jobs) {
			const importPath = job.request.sourcePath ?? job.request.selectedFilePath;
			if (!importPath) continue;

			if (!(await isPathAllowed(importPath))) {
				return Response.json(
					{
						success: false,
						error: `Access denied: Path ${importPath} is outside allowed directories`
					},
					{ status: 403 }
				);
			}

			if (await isPathInsideManagedRoot(importPath)) {
				return Response.json(
					{
						success: false,
						error: `Import source ${importPath} cannot be inside a managed root folder`
					},
					{ status: 400 }
				);
			}
		}

		// Bulk imports (#565 follow-up): enqueue one durable manual_import job
		// per group instead of the old in-memory queue, so the batch survives a
		// restart and gets picked up by the import worker pool. parentJobId
		// groups them for aggregate progress via GET /api/library/jobs.
		const parentJobId = randomUUID();
		const jobIds: string[] = [];
		for (const job of parsed.data.jobs) {
			const importPath = job.request.sourcePath ?? job.request.selectedFilePath;
			const enqueued = libraryJobService.enqueueJob({
				type: 'manual_import',
				parentJobId,
				dedupeKey: `manual_import:${importPath}:${job.request.tmdbId}:${job.request.libraryId ?? 'new'}`,
				metadata: { request: job.request, groupName: job.groupName }
			});
			jobIds.push(enqueued.id);
		}

		logger.info(
			{ parentJobId, count: jobIds.length },
			'[API] Manual import bulk submitted as library jobs'
		);

		return Response.json({
			success: true,
			data: {
				parentJobId,
				totalGroups: parsed.data.jobs.length,
				jobIds
			}
		});
	} catch (error) {
		logger.error('[API] Manual import bulk failed', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to submit import jobs'
			},
			{ status: 500 }
		);
	}
};

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { importFailures, downloadQueue } from '#lib/server/db/schema.js';
import { eq, or, and } from 'drizzle-orm';
import { getImportService } from '#lib/server/downloadClients/import/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'ReportsImportFailuresRetry', logDomain: 'imports' });

/**
 * POST /api/reports/import-failures/[id]/retry
 *
 * Re-triggers the import phase only. Does not restart or re-download
 * the file from the download client. Returns 404 if no matching
 * download queue entry can be found (likely cleaned up already).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const { id } = params;

	const failure = await db.select().from(importFailures).where(eq(importFailures.id, id)).get();

	if (!failure) throw error(404, 'Import failure record not found');
	if (failure.status === 'resolved') {
		return Response.json({ success: false, error: 'Record is already resolved' }, { status: 400 });
	}

	// Find the matching download queue entry.
	// Primary: match on sourcePath against outputPath or clientDownloadPath,
	// scoped to the same download client when available.
	let queueItem: typeof downloadQueue.$inferSelect | undefined;

	if (failure.sourcePath) {
		const pathCondition = or(
			eq(downloadQueue.outputPath, failure.sourcePath),
			eq(downloadQueue.clientDownloadPath, failure.sourcePath)
		);
		const conditions = failure.downloadClientId
			? and(pathCondition, eq(downloadQueue.downloadClientId, failure.downloadClientId))
			: pathCondition;

		queueItem = await db.select().from(downloadQueue).where(conditions).get();
	}

	// Fallback: match on release title + client when path lookup found nothing.
	if (!queueItem && failure.downloadClientId) {
		queueItem = await db
			.select()
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.title, failure.releaseTitle),
					eq(downloadQueue.downloadClientId, failure.downloadClientId)
				)
			)
			.get();
	}

	if (!queueItem) {
		return Response.json(
			{
				success: false,
				error:
					'No matching download queue entry found. It may have been cleaned up after the failure.'
			},
			{ status: 404 }
		);
	}

	const hasPath = Boolean(queueItem.outputPath?.trim() || queueItem.clientDownloadPath?.trim());
	if (!hasPath) {
		return Response.json(
			{
				success: false,
				error: 'Queue entry has no recorded file path. A re-download would be required to retry.'
			},
			{ status: 422 }
		);
	}

	// If the queue item is still failed, reset it to completed so the import
	// service can pick it up. We do NOT re-download or re-add to the client.
	if (queueItem.status === 'failed') {
		await db
			.update(downloadQueue)
			.set({ status: 'completed', errorMessage: null, lastAttemptAt: new Date().toISOString() })
			.where(eq(downloadQueue.id, queueItem.id));
	} else if (!['completed', 'postprocessing'].includes(queueItem.status)) {
		return Response.json(
			{
				success: false,
				error: `Cannot retry import: queue item is in '${queueItem.status}' state.`
			},
			{ status: 400 }
		);
	}

	await db.update(importFailures).set({ status: 'retrying' }).where(eq(importFailures.id, id));

	try {
		const result = await getImportService().requestImport(queueItem.id);
		logger.info(
			{ importFailureId: id, queueItemId: queueItem.id, result },
			'[Reports] Import retry requested'
		);
		return Response.json({
			success: true,
			message: 'Import retry queued',
			importStatus: result.status
		});
	} catch (err) {
		// Roll back the status change so the record doesn't get stuck in 'retrying'
		await db.update(importFailures).set({ status: 'failed' }).where(eq(importFailures.id, id));
		logger.error({ err, importFailureId: id }, '[Reports] Import retry failed');
		const message = err instanceof Error ? err.message : 'Import retry failed';
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};

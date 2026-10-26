/**
 * Library Reconciliation Task
 *
 * Heals drift between libraries, root folders, and their join-table
 * assignments. Runs:
 *   - backfillLibraryRootFolders (seed missing default assignments)
 *   - syncSystemLibrariesFromRootFolders (reconcile system libraries +
 *     root folder assignments)
 *   - promoteAllMissingDefaults (promote the oldest root folder as default
 *     for any media type/subtype that has none - covers data predating
 *     RootFolderService's reactive auto-promotion, with no migration
 *     needed since this self-corrects on the schedule below)
 *
 * Runs every 6 hours by default (configurable on the Tasks settings page).
 * The first two steps are also triggered directly from write paths (root
 * folder + library CRUD) for immediate consistency; promoteAllMissingDefaults
 * only runs here since it's a broader sweep for pre-existing data rather
 * than something a single write could leave inconsistent going forward
 * (RootFolderService's own create/update/delete already call the
 * single-group version of this immediately).
 */

import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { getRootFolderService } from '#lib/server/downloadClients/RootFolderService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { TaskResult } from '../MonitoringScheduler.js';
import type { TaskExecutionContext } from '#lib/server/tasks/TaskExecutionContext.js';

const logger = createChildLogger({ module: 'LibraryReconcileTask', logDomain: 'monitoring' });

export async function executeLibraryReconcileTask(
	ctx: TaskExecutionContext | null
): Promise<TaskResult> {
	const executedAt = new Date();
	logger.info('[LibraryReconcileTask] Starting library reconciliation');

	let reconciled: number;

	try {
		ctx?.checkCancelled();

		const assignmentsBefore = await getAssignmentCount();

		const service = getLibraryEntityService();
		await service.reconcileAll();

		// No default root folder for a media type/subtype can only happen
		// for data predating RootFolderService's own reactive auto-promotion
		// (on create/update/delete) - heal it here instead of a one-off
		// migration, so it self-corrects on this task's normal schedule.
		await getRootFolderService().promoteAllMissingDefaults();

		ctx?.checkCancelled();

		const assignmentsAfter = await getAssignmentCount();
		reconciled = Math.max(0, assignmentsAfter - assignmentsBefore);

		logger.info(
			{ assignmentsBefore, assignmentsAfter, reconciled },
			'[LibraryReconcileTask] Reconciliation completed'
		);

		return {
			taskType: 'library-reconcile',
			itemsProcessed: reconciled,
			itemsGrabbed: 0,
			errors: 0,
			executedAt
		};
	} catch (error) {
		logger.error({ err: error }, '[LibraryReconcileTask] Reconciliation failed');
		throw error;
	}
}

async function getAssignmentCount(): Promise<number> {
	const { db } = await import('#lib/server/db/index.js');
	const { libraryRootFolders } = await import('#lib/server/db/schema.js');
	const { count } = await import('drizzle-orm');
	const result = await db.select({ value: count() }).from(libraryRootFolders).get();
	return Number(result?.value ?? 0);
}

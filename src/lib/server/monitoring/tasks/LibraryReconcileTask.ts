/**
 * Library Reconciliation Task
 *
 * Heals drift between libraries, root folders, and their join-table
 * assignments. Runs:
 *   - backfillLibraryRootFolders (seed missing default assignments)
 *   - syncSystemLibrariesFromRootFolders (reconcile system libraries +
 *     root folder assignments)
 *
 * Runs every 6 hours by default (configurable on the Tasks settings page).
 * Also triggered from write paths (root folder + library CRUD) for
 * immediate consistency.
 */

import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
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

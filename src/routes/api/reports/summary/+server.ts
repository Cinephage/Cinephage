import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import {
	rejectedReleases,
	importFailures,
	renamingFailures,
	unmatchedFiles
} from '#lib/server/db/schema.js';
import { count, ne } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

// Cross-cutting summary across all four report types - not tied to one pipeline stage.
const logger = createChildLogger({ module: 'ReportsSummary', logDomain: 'system' });

/**
 * GET /api/reports/summary
 * Returns unresolved record counts for all diagnostic report types.
 */
export const GET: RequestHandler = async (event) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const [[rejectedCount], [importCount], [renamingCount], [unmatchedCount]] = await Promise.all([
			db
				.select({ count: count() })
				.from(rejectedReleases)
				.where(ne(rejectedReleases.status, 'resolved')),
			db
				.select({ count: count() })
				.from(importFailures)
				.where(ne(importFailures.status, 'resolved')),
			db
				.select({ count: count() })
				.from(renamingFailures)
				.where(ne(renamingFailures.status, 'resolved')),
			db.select({ count: count() }).from(unmatchedFiles)
		]);

		return Response.json({
			success: true,
			data: {
				rejectedReleases: rejectedCount.count,
				importFailures: importCount.count,
				renamingFailures: renamingCount.count,
				unmatchedImports: unmatchedCount.count,
				total: rejectedCount.count + importCount.count + renamingCount.count + unmatchedCount.count
			}
		});
	} catch (err) {
		logger.error({ err }, '[Reports] Failed to load summary counts');
		return Response.json(
			{ success: false, error: 'Failed to load report summary' },
			{ status: 500 }
		);
	}
};

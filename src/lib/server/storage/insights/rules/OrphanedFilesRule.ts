import { count, sql } from 'drizzle-orm';
import { unmatchedFiles } from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';

/**
 * Files discovered on disk during a scan that Cinephage couldn't auto-match
 * to a movie or episode. These are tracked in the unmatched_files table.
 * Deep-links to /library/unmatched for the user to review and match.
 */
export class OrphanedFilesRule implements StorageInsightRule {
	readonly type = 'orphaned-files' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		const orphanedCount = ctx.db.select({ count: count() }).from(unmatchedFiles).get()?.count ?? 0;

		if (orphanedCount === 0) return [];

		const totalSize =
			ctx.db
				.select({ total: sql<number>`COALESCE(SUM(${unmatchedFiles.size}), 0)` })
				.from(unmatchedFiles)
				.get()?.total ?? 0;

		return [
			{
				type: this.type,
				severity: 'warning',
				scope: 'global',
				title: `Unmatched files on disk`,
				summary: `${orphanedCount} file${orphanedCount === 1 ? '' : 's'} found during scans couldn't be matched to a movie or episode. Review and match them manually.`,
				details: { link: '/library/unmatched' },
				reclaimableBytes: totalSize,
				itemCount: orphanedCount
			}
		];
	}
}

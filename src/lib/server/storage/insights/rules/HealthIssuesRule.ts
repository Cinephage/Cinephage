import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { libraries, libraryScanHistory, rootFolders } from '#lib/server/db/schema.js';
import type { StorageInsightRule, RuleContext, InsightFinding } from '../types.js';

/**
 * Aggregates health signals across root folders and libraries.
 * Produces up to 4 separate findings (one per health check type) so the UI
 * can show each with its own severity and drill-down.
 */
export class HealthIssuesRule implements StorageInsightRule {
	readonly type = 'health-issues' as const;

	async evaluate(ctx: RuleContext): Promise<InsightFinding[]> {
		const findings: InsightFinding[] = [];

		// Load all root folders
		const folders = ctx.db.select().from(rootFolders).all();

		// 1. Inaccessible root folders (critical) — path doesn't exist or not readable
		const inaccessibleFolders = folders.filter((f) => !existsSync(f.path));
		if (inaccessibleFolders.length > 0) {
			findings.push({
				type: this.type,
				severity: 'critical',
				scope: 'global',
				title: `Inaccessible root folders`,
				summary: `${inaccessibleFolders.length} root folder${inaccessibleFolders.length === 1 ? '' : 's'} could not be reached on disk. Imports and scans for ${inaccessibleFolders.length === 1 ? 'this folder' : 'these folders'} will fail.`,
				details: {
					folderIds: inaccessibleFolders.map((f) => f.id),
					folderPaths: inaccessibleFolders.map((f) => f.path)
				},
				itemCount: inaccessibleFolders.length
			});
		}

		// 2. Read-only root folders (info) — informational, not an error
		const readOnlyFolders = folders.filter((f) => f.readOnly);
		if (readOnlyFolders.length > 0) {
			findings.push({
				type: this.type,
				severity: 'info',
				scope: 'global',
				title: `Read-only root folders`,
				summary: `${readOnlyFolders.length} root folder${readOnlyFolders.length === 1 ? ' is' : 's are'} configured as read-only. Imports are disabled for ${readOnlyFolders.length === 1 ? 'it' : 'them'}.`,
				details: { folderIds: readOnlyFolders.map((f) => f.id) },
				itemCount: readOnlyFolders.length
			});
		}

		// 3. Root folders needing scan (warning) — no completed scan history.
		// Scoped to one row per root folder (the most recent scan) via a
		// correlated MAX(startedAt) subquery, instead of loading the entire
		// scan-history table.
		const latestScans = ctx.db
			.select({
				rootFolderId: libraryScanHistory.rootFolderId,
				status: libraryScanHistory.status
			})
			.from(libraryScanHistory)
			.where(
				sql`${libraryScanHistory.startedAt} = (
					SELECT MAX(started_at) FROM library_scan_history h2
					WHERE h2.root_folder_id = ${libraryScanHistory.rootFolderId}
				)`
			)
			.all();

		const latestScanByFolder = new Map<string, string>();
		for (const scan of latestScans) {
			if (scan.rootFolderId && !latestScanByFolder.has(scan.rootFolderId)) {
				latestScanByFolder.set(scan.rootFolderId, scan.status);
			}
		}

		const needsScanFolders = folders.filter(
			(f) => !latestScanByFolder.has(f.id) || latestScanByFolder.get(f.id) !== 'completed'
		);
		if (needsScanFolders.length > 0) {
			findings.push({
				type: this.type,
				severity: 'warning',
				scope: 'global',
				title: `Root folders needing a scan`,
				summary: `${needsScanFolders.length} root folder${needsScanFolders.length === 1 ? '' : 's'} ${needsScanFolders.length === 1 ? 'has' : 'have'} never been scanned or the last scan didn't complete.`,
				details: { folderIds: needsScanFolders.map((f) => f.id) },
				itemCount: needsScanFolders.length
			});
		}

		// 4. Libraries without root folder (warning)
		const libsWithoutFolder = ctx.db
			.select({ id: libraries.id })
			.from(libraries)
			.where(sql`${libraries.defaultRootFolderId} IS NULL AND ${libraries.isSystem} = 0`)
			.all();

		if (libsWithoutFolder.length > 0) {
			const libCount = libsWithoutFolder.length;
			findings.push({
				type: this.type,
				severity: 'warning',
				scope: 'global',
				title: `Libraries without a root folder`,
				summary: `${libCount} librar${libCount === 1 ? 'y' : 'ies'} ${libCount === 1 ? 'has' : 'have'} no default root folder configured. New additions won't know where to go.`,
				details: { libraryIds: libsWithoutFolder.map((l) => l.id) },
				itemCount: libCount
			});
		}

		return findings;
	}
}

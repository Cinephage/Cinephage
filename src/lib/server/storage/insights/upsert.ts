import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { storageInsights } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { InsightFinding } from './types.js';

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Match key for finding <-> existing row correlation.
 * Two findings match if they have the same (type, scope, scopeId).
 * null scopeId is treated as a value (global insights).
 */
function matchKey(type: string, scope: string, scopeId: string | null | undefined): string {
	return `${type}:${scope}:${scopeId ?? '__null__'}`;
}

/**
 * Sync an array of findings into the storage_insights table.
 *
 * - Findings with a matching existing row: update lastDetectedAt, itemCount,
 *   details, title, summary, severity. Clear dismissedAt/dismissedBy on re-detection.
 * - Findings with no match: insert new row.
 * - Existing non-dismissed rows not in findings: delete (issue resolved).
 * - Existing dismissed rows not in findings: keep for audit history.
 *
 * Wrapped in a single transaction for atomicity.
 */
export function upsertInsights(findings: InsightFinding[], now: string): void {
	db.transaction((tx) => {
		const existingRows = tx.select().from(storageInsights).all();

		const existingByKey = new Map<string, typeof storageInsights.$inferSelect>();
		for (const row of existingRows) {
			existingByKey.set(matchKey(row.insightType, row.scope, row.scopeId), row);
		}

		const seenIds = new Set<string>();

		for (const finding of findings) {
			const key = matchKey(finding.type, finding.scope, finding.scopeId ?? null);
			const existing = existingByKey.get(key);

			if (existing) {
				seenIds.add(existing.id);
				tx.update(storageInsights)
					.set({
						title: finding.title,
						summary: finding.summary,
						severity: finding.severity,
						itemCount: finding.itemCount,
						reclaimableBytes: finding.reclaimableBytes ?? null,
						detailsJson: finding.details ? JSON.stringify(finding.details) : null,
						lastDetectedAt: now,
						dismissedAt: null,
						dismissedBy: null
					})
					.where(eq(storageInsights.id, existing.id))
					.run();
			} else {
				const [inserted] = tx
					.insert(storageInsights)
					.values({
						insightType: finding.type,
						severity: finding.severity,
						scope: finding.scope,
						scopeId: finding.scopeId ?? null,
						title: finding.title,
						summary: finding.summary,
						detailsJson: finding.details ? JSON.stringify(finding.details) : null,
						reclaimableBytes: finding.reclaimableBytes ?? null,
						itemCount: finding.itemCount,
						firstDetectedAt: now,
						lastDetectedAt: now
					})
					.returning({ id: storageInsights.id })
					.all();
				seenIds.add(inserted.id);
			}
		}

		// Delete non-dismissed rows not seen this run (issue resolved).
		// Dismissed rows are kept for audit history.
		const toDelete = existingRows.filter((r) => !seenIds.has(r.id) && r.dismissedAt === null);
		for (const row of toDelete) {
			tx.delete(storageInsights).where(eq(storageInsights.id, row.id)).run();
		}

		logger.info(
			`[Insights] upsert: ${findings.length} findings -> ${seenIds.size} kept/inserted, ${toDelete.length} resolved+deleted`
		);
	});
}

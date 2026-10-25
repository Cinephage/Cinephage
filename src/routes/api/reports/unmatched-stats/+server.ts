import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { unmatchedFiles } from '#lib/server/db/schema.js';
import { count, gt, inArray } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'ReportsUnmatchedStats', logDomain: 'scans' });

export const GET: RequestHandler = async (event) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const cutoff24h = new Date(Date.now() - 86_400_000).toISOString();

		const [[total], [newIn24h], [noMatch], [parseFailures], [belowThreshold]] = await Promise.all([
			db.select({ count: count() }).from(unmatchedFiles),
			db
				.select({ count: count() })
				.from(unmatchedFiles)
				.where(gt(unmatchedFiles.discoveredAt, cutoff24h)),
			db
				.select({ count: count() })
				.from(unmatchedFiles)
				.where(inArray(unmatchedFiles.reason, ['no_match'])),
			db
				.select({ count: count() })
				.from(unmatchedFiles)
				.where(inArray(unmatchedFiles.reason, ['parse_failed'])),
			db
				.select({ count: count() })
				.from(unmatchedFiles)
				.where(inArray(unmatchedFiles.reason, ['low_confidence', 'multiple_matches', 'ambiguous']))
		]);

		return Response.json({
			success: true,
			data: {
				total: total.count,
				newIn24h: newIn24h.count,
				noMatch: noMatch.count,
				parseFailures: parseFailures.count,
				belowThreshold: belowThreshold.count
			}
		});
	} catch (err) {
		logger.error({ err }, '[Reports] Failed to load unmatched stats');
		return Response.json({ success: false, error: 'Failed to load stats' }, { status: 500 });
	}
};

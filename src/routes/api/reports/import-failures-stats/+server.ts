import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { importFailures } from '#lib/server/db/schema.js';
import { count, eq, ne, and, gt } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'ReportsImportFailuresStats', logDomain: 'imports' });

export const GET: RequestHandler = async (event) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const cutoff24h = new Date(Date.now() - 86_400_000).toISOString();
		const active = ne(importFailures.status, 'resolved');

		const [
			[total],
			[newIn24h],
			[pathResolution],
			[diskSpace],
			[dangerousFiles],
			[transfer],
			[maxRetries]
		] = await Promise.all([
			db.select({ count: count() }).from(importFailures).where(active),
			db
				.select({ count: count() })
				.from(importFailures)
				.where(and(active, gt(importFailures.failedAt, cutoff24h))),
			db
				.select({ count: count() })
				.from(importFailures)
				.where(and(active, eq(importFailures.failureStage, 'path_resolution'))),
			db
				.select({ count: count() })
				.from(importFailures)
				.where(and(active, eq(importFailures.failureStage, 'disk_space'))),
			db
				.select({ count: count() })
				.from(importFailures)
				.where(and(active, eq(importFailures.failureStage, 'dangerous_files'))),
			db
				.select({ count: count() })
				.from(importFailures)
				.where(and(active, eq(importFailures.failureStage, 'transfer'))),
			db
				.select({ count: count() })
				.from(importFailures)
				.where(and(active, eq(importFailures.failureStage, 'max_retries')))
		]);

		return Response.json({
			success: true,
			data: {
				total: total.count,
				newIn24h: newIn24h.count,
				pathResolution: pathResolution.count,
				diskSpace: diskSpace.count,
				dangerousFiles: dangerousFiles.count,
				transfer: transfer.count,
				maxRetries: maxRetries.count
			}
		});
	} catch (err) {
		logger.error({ err }, '[Reports] Failed to load import failure stats');
		return Response.json({ success: false, error: 'Failed to load stats' }, { status: 500 });
	}
};

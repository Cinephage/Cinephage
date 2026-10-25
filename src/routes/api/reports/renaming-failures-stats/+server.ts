import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { renamingFailures } from '#lib/server/db/schema.js';
import { count, eq, ne, and, gt, or } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'ReportsRenamingFailuresStats', logDomain: 'scans' });

export const GET: RequestHandler = async (event) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const cutoff24h = new Date(Date.now() - 86_400_000).toISOString();
		const active = ne(renamingFailures.status, 'resolved');

		const [[total], [newIn24h], [collisions], [permissionIo]] = await Promise.all([
			db.select({ count: count() }).from(renamingFailures).where(active),
			db
				.select({ count: count() })
				.from(renamingFailures)
				.where(and(active, gt(renamingFailures.failedAt, cutoff24h))),
			db
				.select({ count: count() })
				.from(renamingFailures)
				.where(and(active, eq(renamingFailures.reason, 'collision'))),
			db
				.select({ count: count() })
				.from(renamingFailures)
				.where(
					and(
						active,
						or(
							eq(renamingFailures.reason, 'permission_denied'),
							eq(renamingFailures.reason, 'io_error'),
							eq(renamingFailures.reason, 'disk_full')
						)
					)
				)
		]);

		return Response.json({
			success: true,
			data: {
				total: total.count,
				newIn24h: newIn24h.count,
				collisions: collisions.count,
				permissionIo: permissionIo.count
			}
		});
	} catch (err) {
		logger.error({ err }, '[Reports] Failed to load renaming failure stats');
		return Response.json({ success: false, error: 'Failed to load stats' }, { status: 500 });
	}
};

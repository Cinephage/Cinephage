/**
 * History Storage Forecast API
 *
 * GET /api/settings/library/history-retention/forecast
 *
 * Returns estimated storage usage and projections for history tables.
 */

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { sql } from 'drizzle-orm';

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	// Estimate current byte usage via SQLite PRAGMA or row counts
	const rows = await Promise.all([
		db.get<{ bytes: number }>(
			sql`SELECT (SELECT COUNT(*) FROM "library_scan_history") * 300 AS bytes`
		),
		db.get<{ bytes: number }>(
			sql`SELECT (SELECT COUNT(*) FROM "monitoring_history") * 400 AS bytes`
		),
		db.get<{ bytes: number }>(sql`SELECT (SELECT COUNT(*) FROM "download_history") * 350 AS bytes`),
		db.get<{ bytes: number }>(sql`SELECT (SELECT COUNT(*) FROM "subtitle_history") * 250 AS bytes`),
		db.get<{ bytes: number }>(sql`SELECT (SELECT COUNT(*) FROM "task_history") * 200 AS bytes`)
	]);

	const totalBytes = rows.reduce((sum, r) => sum + (r?.bytes ?? 0), 0);

	// Rough average daily growth estimate
	const avgDailyBytes = Math.max(1, Math.round(totalBytes / 30));

	return Response.json({
		currentEstimatedBytes: totalBytes,
		averageDailyBytes: avgDailyBytes,
		projectedBytes30d: totalBytes + avgDailyBytes * 30,
		projectedBytes90d: totalBytes + avgDailyBytes * 90
	});
};

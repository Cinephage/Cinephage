import { asc, isNull, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { storageInsights } from '#lib/server/db/schema.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import type { RequestHandler } from './$types';

const SEVERITY_ORDER = sql`CASE ${storageInsights.severity}
	WHEN 'critical' THEN 0
	WHEN 'warning' THEN 1
	WHEN 'info' THEN 2
	ELSE 3
END`;

export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const rows = db
		.select()
		.from(storageInsights)
		.where(isNull(storageInsights.dismissedAt))
		.orderBy(asc(SEVERITY_ORDER), asc(storageInsights.insightType))
		.all();

	return Response.json({ success: true, insights: rows });
};

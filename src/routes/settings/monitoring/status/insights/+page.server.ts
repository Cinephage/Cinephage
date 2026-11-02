import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.js';
import { storageInsights } from '#lib/server/db/schema.js';
import { sql } from 'drizzle-orm';

export const load: PageServerLoad = async ({ parent }) => {
	await parent();

	// Load ALL insights (including dismissed) for the full management view
	const allInsights = db
		.select()
		.from(storageInsights)
		.orderBy(
			sql`CASE ${storageInsights.dismissedAt} IS NULL WHEN 0 THEN 0 ELSE 1 END`,
			sql`CASE ${storageInsights.severity}
				WHEN 'critical' THEN 0
				WHEN 'warning' THEN 1
				WHEN 'info' THEN 2
				ELSE 3
			END`,
			storageInsights.insightType
		)
		.all();

	return { allInsights };
};

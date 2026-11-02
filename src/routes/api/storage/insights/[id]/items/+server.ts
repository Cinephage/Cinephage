import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { storageInsights } from '#lib/server/db/schema.js';
import { requireAuth } from '#lib/server/auth/authorization.js';
import { getInsightItemResolver } from '#lib/server/storage/insights/items/registry.js';
import { getInsightsService } from '#lib/server/storage/insights/InsightsService.js';
import type { InsightType } from '#lib/server/storage/insights/types.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const authError = requireAuth(event);
	if (authError) return authError;

	const insightId = event.params.id;
	if (!insightId) {
		throw error(400, 'Insight ID is required');
	}

	const page = Math.max(1, parseInt(event.url.searchParams.get('page') ?? '1', 10) || 1);
	const limit = Math.min(
		100,
		Math.max(1, parseInt(event.url.searchParams.get('limit') ?? '50', 10) || 50)
	);

	const insight = db.select().from(storageInsights).where(eq(storageInsights.id, insightId)).get();

	if (!insight) {
		throw error(404, 'Insight not found');
	}

	const resolver = getInsightItemResolver(insight.insightType as InsightType);
	const result = await resolver({ db, insight, page, limit });

	// The rule that produced this insight caches itemCount/summary at
	// evaluation time, while this resolver always live-queries storage_items.
	// A reconcile/sync between the rule's last run and this request can leave
	// the cached count out of step with what's actually listed (#601).
	// Re-run the rules (full set - upsertInsights treats a partial findings
	// array as "everything else resolved" and would delete unrelated
	// insights) so the stored row - and what we hand back here - matches
	// the live total the user is looking at.
	let freshInsight = insight;
	if (result.total !== insight.itemCount) {
		await getInsightsService().runAllRules();
		freshInsight =
			db.select().from(storageInsights).where(eq(storageInsights.id, insightId)).get() ?? insight;
	}

	return Response.json({
		success: true,
		data: {
			items: result.items,
			pagination: {
				page,
				limit,
				total: result.total,
				totalPages: Math.max(1, Math.ceil(result.total / limit))
			}
		},
		meta: {
			insightId,
			insightType: insight.insightType,
			filters: { page, limit },
			insight: {
				itemCount: freshInsight.itemCount,
				summary: freshInsight.summary,
				title: freshInsight.title
			}
		}
	});
};

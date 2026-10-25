import { error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { storageInsights } from '#lib/server/db/schema.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { storageEvents } from '#lib/server/storage/StorageEvents.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const insightId = event.params.id;
	if (!insightId) {
		throw error(400, 'Insight ID is required');
	}

	const user = event.locals.user;
	if (!user?.id) {
		throw error(401, 'Not authenticated');
	}

	const result = db
		.update(storageInsights)
		.set({ dismissedAt: null, dismissedBy: null })
		.where(and(eq(storageInsights.id, insightId), sql`${storageInsights.dismissedAt} IS NOT NULL`))
		.returning({ id: storageInsights.id })
		.all();

	if (result.length === 0) {
		throw error(404, 'Insight not found or not dismissed');
	}

	storageEvents.emitInsightUndismissed({ insightId });

	return Response.json({ success: true, id: result[0].id });
};

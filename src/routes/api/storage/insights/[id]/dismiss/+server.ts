import { error } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
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

	const userId = event.locals.user?.id;
	if (!userId) {
		throw error(401, 'Not authenticated');
	}

	const now = new Date().toISOString();
	const result = db
		.update(storageInsights)
		.set({ dismissedAt: now, dismissedBy: userId })
		.where(and(eq(storageInsights.id, insightId), isNull(storageInsights.dismissedAt)))
		.returning({ id: storageInsights.id })
		.all();

	if (result.length === 0) {
		throw error(404, 'Insight not found or already dismissed');
	}

	storageEvents.emitInsightDismissed({ insightId, dismissedAt: now });

	return Response.json({ success: true, id: result[0].id, dismissedAt: now });
};

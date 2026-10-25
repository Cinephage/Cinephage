import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getUpcomingItems } from '#lib/server/calendar/queries.js';
import { getUserPreference } from '#lib/server/preferences/user-preferences.js';

const upcomingQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(20).default(7)
});

export const GET: RequestHandler = async ({ url, locals }) => {
	const result = upcomingQuerySchema.safeParse(Object.fromEntries(url.searchParams));
	if (!result.success) {
		return Response.json({ error: 'Invalid parameters' }, { status: 400 });
	}
	if (!locals.user) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const prefs = await getUserPreference(locals.user.id, 'calendar');
	const items = await getUpcomingItems(result.data.limit, prefs.upcomingShowNonLibrary);
	return Response.json(items);
};

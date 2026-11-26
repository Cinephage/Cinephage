/**
 * The caller's own calendar-feed subscription.
 *
 * GET  - the feed URL plus its options and usage (creates the key on first call)
 * PUT  - replace the options; the URL does not change
 *
 * Self-service: any signed-in account owns exactly one feed, scoped to its own
 * API key, so no admin gate applies. The credential never leaves that account.
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { parseBody } from '#lib/server/api/validate.js';
import { calendarFeedConfigSchema } from '#lib/validation/schemas.js';
import {
	ensureCalendarFeedSubscription,
	saveCalendarFeedConfig,
	type CalendarFeedSubscription
} from '#lib/server/auth/api-keys.js';
import { appendBasePath, getBaseUrlAsync, isLanOnlyUrl } from '#lib/server/streaming/url.js';

const FEED_PATH = '/api/calendar/feed.ics';

const updateSchema = z.object({ config: calendarFeedConfigSchema });

/** Build the payload the settings modal renders. */
function payload(subscription: CalendarFeedSubscription, baseUrl: string) {
	return {
		success: true,
		url: subscription.key
			? `${appendBasePath(baseUrl, FEED_PATH)}?api_key=${encodeURIComponent(subscription.key)}`
			: null,
		config: subscription.config,
		createdAt: subscription.createdAt,
		lastRequest: subscription.lastRequest,
		lanOnly: isLanOnlyUrl(baseUrl)
	};
}

export const GET: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const subscription = await ensureCalendarFeedSubscription(locals.user.id);
	const baseUrl = await getBaseUrlAsync(request);

	return Response.json(payload(subscription, baseUrl));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const body = await parseBody(request, updateSchema);
	const saved = await saveCalendarFeedConfig(locals.user.id, body.config);
	if (!saved) {
		return Response.json({ success: false, error: 'Calendar feed key missing' }, { status: 404 });
	}

	const baseUrl = await getBaseUrlAsync(request);
	return Response.json(payload(saved, baseUrl));
};

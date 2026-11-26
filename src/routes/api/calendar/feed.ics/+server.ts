/**
 * GET /api/calendar/feed.ics
 *
 * A read-only iCalendar feed of the account's monitored releases. The
 * credential is the per-account calendar key minted by
 * `/api/calendar/subscription`; `hooks.server.ts` verifies it and puts the key
 * row on `locals`, so this route never parses the credential itself.
 */

import type { RequestHandler } from './$types';
import { getCalendarFeedConfigForKey } from '#lib/server/auth/api-keys.js';
import { getCalendarFeedEvents } from '#lib/server/calendar/feed.js';
import { buildCalendarFeed, calendarFeedEtag, etagMatches } from '#lib/server/calendar/ical.js';

const PUBLISHED_TTL = 'PT1H';

export const GET: RequestHandler = async ({ locals, request }) => {
	if (!locals.apiKeyId) {
		return Response.json(
			{ success: false, error: 'API key required', code: 'API_KEY_REQUIRED' },
			{ status: 401 }
		);
	}

	const config = getCalendarFeedConfigForKey(locals.apiKeyId);
	const events = await getCalendarFeedEvents(config);
	const body = buildCalendarFeed(events, { calendarName: 'Cinephage' });
	const etag = calendarFeedEtag(body);

	if (etagMatches(request.headers.get('if-none-match'), etag)) {
		return new Response(null, {
			status: 304,
			headers: { ETag: etag, 'X-PUBLISHED-TTL': PUBLISHED_TTL }
		});
	}

	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': 'inline; filename="cinephage.ics"',
			// Calendar clients poll on their own schedule; the ETag is what makes
			// a repeated poll cheap.
			'Cache-Control': 'private, max-age=300',
			ETag: etag,
			'X-PUBLISHED-TTL': PUBLISHED_TTL
		}
	});
};

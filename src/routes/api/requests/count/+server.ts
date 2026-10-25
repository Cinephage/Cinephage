/**
 * Counts + quota for badges and quota displays.
 *
 * GET /api/requests/count — viewers: own per-status counts + own quota;
 *                           admins: global counts + pending for the badge.
 */

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { requests } from '#lib/server/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getRequestService } from '#lib/server/requests/RequestService.js';
import { getRequestSettingsService } from '#lib/server/requests/RequestSettingsService.js';
import { requesterFromLocals } from '#lib/server/requests/http.js';

export const GET: RequestHandler = async (event) => {
	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	const base = db.select({ status: requests.status, count: sql<number>`count(*)` }).from(requests);

	const rows =
		requester.role === 'admin'
			? await base.groupBy(requests.status)
			: await base.where(eq(requests.requestedBy, requester.id)).groupBy(requests.status);

	const counts: Record<string, number> = {
		total: 0,
		pending: 0,
		approved: 0,
		awaiting_target: 0,
		failed: 0,
		declined: 0,
		expired: 0,
		cancelled: 0,
		fulfilled: 0
	};
	for (const row of rows) {
		counts[row.status] = row.count;
		counts.total += row.count;
	}

	const quota = await getRequestService().getQuota(requester.id, requester.role);
	const autoApprove = {
		movie: await getRequestService().getEffectiveAutoApprove(requester.id, requester.role, 'movie'),
		series: await getRequestService().getEffectiveAutoApprove(
			requester.id,
			requester.role,
			'series'
		)
	};

	const globalSettings = await getRequestSettingsService().getRequestSettings();

	return Response.json({
		success: true,
		counts,
		quota,
		autoApprove,
		tvQuotaUnit: globalSettings.tvQuotaUnit
	});
};

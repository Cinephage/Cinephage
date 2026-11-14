/**
 * GET /api/monitoring/search-activity
 *
 * Read-only recency feed of automatic search attempts (all statuses, not
 * just failures), backing the Activity page's "Searches" tab. Separate from
 * /api/activity's History tab, which deliberately narrows to error/skipped
 * monitoring rows - this endpoint is the full feed, so a retry loop like
 * issue #658's incident is visible before it needs dozens of attempts to
 * become obvious.
 *
 * Query params: mediaType? ('movie' | 'tv'), status? (searched | found |
 * grabbed | no_results | skipped | error), pausedOnly? ('true' to show only
 * items with auto-search paused), search? (case-insensitive contains on the
 * resolved media title), startDate?/endDate? (YYYY-MM-DD, same date-filter
 * convention as Activity), sort? ('media' | 'status' | 'releasesFound' |
 * 'failures' | 'time'), order? ('asc' | 'desc', default 'desc'), page?
 * (default 1), limit? (default 25, max 100).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { activityService } from '#lib/server/activity/ActivityService.js';
import type { SearchActivityStatus } from '#lib/server/activity/activity-transformers.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SearchActivityApi', logDomain: 'monitoring' });

const STATUSES = new Set<SearchActivityStatus>([
	'searched',
	'found',
	'grabbed',
	'no_results',
	'skipped',
	'error'
]);

function toOptionalInt(value: string | null): number | undefined {
	if (value === null || value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	try {
		const mediaTypeParam = url.searchParams.get('mediaType');
		const mediaType =
			mediaTypeParam === 'movie' || mediaTypeParam === 'tv' ? mediaTypeParam : undefined;

		const statusParam = url.searchParams.get('status');
		const status =
			statusParam && STATUSES.has(statusParam as SearchActivityStatus)
				? (statusParam as SearchActivityStatus)
				: undefined;

		const sortParam = url.searchParams.get('sort');
		const sort =
			sortParam === 'media' ||
			sortParam === 'status' ||
			sortParam === 'releasesFound' ||
			sortParam === 'failures' ||
			sortParam === 'time'
				? sortParam
				: undefined;
		const orderParam = url.searchParams.get('order');
		const order = orderParam === 'asc' || orderParam === 'desc' ? orderParam : undefined;

		const limit = Math.min(toOptionalInt(url.searchParams.get('limit')) ?? 25, 100);

		const result = await activityService.fetchSearchActivity({
			mediaType,
			status,
			pausedOnly: url.searchParams.get('pausedOnly') === 'true',
			search: url.searchParams.get('search') ?? undefined,
			startDate: url.searchParams.get('startDate') ?? undefined,
			endDate: url.searchParams.get('endDate') ?? undefined,
			sort,
			order,
			page: toOptionalInt(url.searchParams.get('page')) ?? 1,
			limit
		});

		return json({ success: true, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, 'Search activity listing failed');
		return json({ success: false, error: message }, { status: 500 });
	}
};

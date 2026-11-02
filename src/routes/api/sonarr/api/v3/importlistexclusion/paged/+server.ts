import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { requireArrCompatEnabled } from '#lib/server/arr/requireArrCompatEnabled.js';
import { blockedMediaService } from '#lib/server/blocked-media/service.js';
import { getOrAssignArrIds } from '#lib/server/arr/ArrIdMappingService.js';

/**
 * GET /api/sonarr/api/v3/importlistexclusion/paged - Sonarr's "don't re-add
 * this series" list. Cinephage's equivalent is Blocked Media (mediaType: 'tv').
 */
export const GET: RequestHandler = async (event) => {
	const disabledError = requireArrCompatEnabled();
	if (disabledError) return disabledError;

	const authError = requireAdmin(event);
	if (authError) return authError;

	const url = event.url;
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
	const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '10', 10) || 10;
	const sortKey = url.searchParams.get('sortKey') ?? 'title';
	const sortDirection = url.searchParams.get('sortDirection') ?? 'ascending';

	const { entries, total } = await blockedMediaService.getBlockedMedia({
		mediaType: 'tv',
		limit: pageSize,
		offset: (page - 1) * pageSize
	});

	const arrIds = await getOrAssignArrIds(
		'blockedMedia',
		entries.map((entry) => entry.id)
	);

	return Response.json({
		page,
		pageSize,
		sortKey,
		sortDirection,
		totalRecords: total,
		records: entries.map((entry) => ({
			id: arrIds.get(entry.id),
			tmdbId: entry.tmdbId,
			title: entry.title
		}))
	});
};

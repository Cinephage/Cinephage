/**
 * Smart List Detail Page - Server Load
 */

import type { PageServerLoad } from './$types';
import { getSmartListService } from '#lib/server/smartlists/index.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { error } from '@sveltejs/kit';
import { getBlockedTmdbIdSet } from '#lib/server/library/status.js';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requireAdminPage(locals);
	const service = getSmartListService();
	const list = await service.getSmartList(params.id);

	if (!list) {
		throw error(404, 'Smart list not found');
	}

	const page = parseInt(url.searchParams.get('page') ?? '1');
	const inLibrary = url.searchParams.get('inLibrary');
	const includeExcluded = url.searchParams.get('includeExcluded') === 'true';
	const query = url.searchParams.get('q') ?? '';
	const GRID_PAGE_SIZE = 36; // LCM of 9 (desktop cols) and 4 (mobile cols) for full rows on both

	const items = await service.getSmartListItems(params.id, {
		page,
		limit: GRID_PAGE_SIZE,
		inLibrary: inLibrary === 'true' ? true : inLibrary === 'false' ? false : null,
		includeExcluded,
		query
	});

	const blockedIds = await getBlockedTmdbIdSet('all');
	const filteredItems =
		blockedIds.size > 0 ? items.items.filter((item) => !blockedIds.has(item.tmdbId)) : items.items;

	return {
		list,
		items: filteredItems,
		filters: {
			inLibrary: inLibrary === 'true' ? 'in' : inLibrary === 'false' ? 'out' : 'all',
			showExcluded: includeExcluded,
			query
		},
		pagination: {
			page: items.page,
			totalPages: items.totalPages,
			totalItems: items.totalItems
		}
	};
};

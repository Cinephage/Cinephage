/**
 * Smart List Items API
 * GET /api/smartlists/[id]/items - Get items in a smart list
 * POST /api/smartlists/[id]/items - Bulk actions on items
 */

import type { RequestHandler } from './$types';
import { getSmartListService } from '#lib/server/smartlists/index.js';
import { z } from 'zod';
import { smartListItemsActionSchema } from '#lib/validation/schemas.js';
import { getBlockedTmdbIdSet } from '#lib/server/library/status.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const service = getSmartListService();

	const list = await service.getSmartList(params.id);
	if (!list) {
		return Response.json({ error: 'Smart list not found' }, { status: 404 });
	}

	const page = parseInt(url.searchParams.get('page') ?? '1', 10);
	const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
	const inLibraryParam = url.searchParams.get('inLibrary');
	const includeExcluded = url.searchParams.get('includeExcluded') === 'true';
	const query = url.searchParams.get('q') ?? undefined;

	let inLibrary: boolean | null = null;
	if (inLibraryParam === 'true') inLibrary = true;
	else if (inLibraryParam === 'false') inLibrary = false;

	const items = await service.getSmartListItems(params.id, {
		page,
		limit,
		inLibrary,
		includeExcluded,
		query
	});

	const blockedIds = await getBlockedTmdbIdSet('all');
	const itemsList = items.items;
	const filtered =
		blockedIds.size > 0 ? itemsList.filter((item) => !blockedIds.has(item.tmdbId)) : itemsList;

	return Response.json({
		items: {
			...items,
			items: filtered
		},
		page,
		limit,
		total: list.cachedItemCount ?? 0,
		query: query ?? null
	});
};

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const data = smartListItemsActionSchema.parse(body);

		const service = getSmartListService();

		const list = await service.getSmartList(params.id);
		if (!list) {
			return Response.json({ error: 'Smart list not found' }, { status: 404 });
		}

		if (data.action === 'exclude' && data.tmdbIds) {
			for (const tmdbId of data.tmdbIds) {
				await service.excludeItem(params.id, tmdbId);
			}
			return Response.json({ success: true, excluded: data.tmdbIds.length });
		}

		if (data.action === 'include' && data.tmdbIds) {
			for (const tmdbId of data.tmdbIds) {
				await service.includeItem(params.id, tmdbId);
			}
			return Response.json({ success: true, included: data.tmdbIds.length });
		}

		if (data.action === 'addToLibrary' && data.itemIds && data.itemIds.length > 0) {
			const result = await service.bulkAddToLibrary(params.id, data.itemIds);
			return Response.json(result);
		}

		if (data.action === 'addToLibrary' && data.tmdbIds && data.tmdbIds.length > 0) {
			const result = await service.bulkAddToLibraryByTmdbIds(params.id, data.tmdbIds);
			return Response.json(result);
		}

		return Response.json({ error: 'Invalid action or missing parameters' }, { status: 400 });
	} catch (error) {
		if (error instanceof z.ZodError) {
			return Response.json({ error: 'Validation failed', details: error.issues }, { status: 400 });
		}
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};

/**
 * Smart Lists API - Collection endpoints
 * GET /api/smartlists - List all smart lists
 * POST /api/smartlists - Create a new smart list
 */

import type { RequestHandler } from './$types';
import { getSmartListService } from '#lib/server/smartlists/index.js';
import { db } from '#lib/server/db/index.js';
import { rootFolders } from '#lib/server/db/schema.js';
import { smartListCreateSchema } from '#lib/validation/schemas.js';
import { eq } from 'drizzle-orm';
import { parseBody } from '#lib/server/api/validate.js';

export const GET: RequestHandler = async () => {
	const service = getSmartListService();
	const lists = await service.getAllSmartLists();
	return Response.json(lists);
};

export const POST: RequestHandler = async ({ request }) => {
	const data = await parseBody(request, smartListCreateSchema);

	const autoAddBehavior = data.autoAddBehavior ?? 'disabled';
	const rootFolderId = data.rootFolderId?.trim();
	if (autoAddBehavior !== 'disabled' && !rootFolderId) {
		return Response.json(
			{ error: 'Root folder is required when Auto Search is enabled' },
			{ status: 400 }
		);
	}

	if (autoAddBehavior !== 'disabled' && rootFolderId) {
		const [folder] = await db
			.select({
				id: rootFolders.id,
				mediaType: rootFolders.mediaType,
				readOnly: rootFolders.readOnly
			})
			.from(rootFolders)
			.where(eq(rootFolders.id, rootFolderId))
			.limit(1);

		if (!folder) {
			return Response.json({ error: 'Selected root folder was not found' }, { status: 400 });
		}

		if (folder.mediaType !== data.mediaType) {
			const expected = data.mediaType === 'movie' ? 'movie' : 'TV';
			const actual = folder.mediaType === 'movie' ? 'movie' : 'TV';
			return Response.json(
				{
					error: `Selected root folder is a ${actual} folder. Choose a ${expected} folder.`
				},
				{ status: 400 }
			);
		}

		if (folder.readOnly) {
			return Response.json(
				{ error: 'Selected root folder is read-only. Choose a writable folder.' },
				{ status: 400 }
			);
		}
	}

	const service = getSmartListService();
	const list = await service.createSmartList({
		...data,
		rootFolderId: rootFolderId || undefined
	});

	return Response.json(list, { status: 201 });
};

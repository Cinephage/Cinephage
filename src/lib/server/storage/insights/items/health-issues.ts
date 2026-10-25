import { libraries, rootFolders } from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import type { InsightItemResolver } from './types.js';

export const healthIssuesResolver: InsightItemResolver = async ({ db, insight, page, limit }) => {
	const rawDetails = insight.detailsJson ? JSON.parse(insight.detailsJson) : null;
	const tone = (insight.severity === 'critical' ? 'critical' : 'warn') as 'critical' | 'warn';

	// Libraries without a root folder
	if (Array.isArray(rawDetails?.libraryIds) && rawDetails.libraryIds.length > 0) {
		const allIds: string[] = rawDetails.libraryIds;
		const total = allIds.length;
		const slicedIds = allIds.slice((page - 1) * limit, (page - 1) * limit + limit);

		const rows = db
			.select({ id: libraries.id, name: libraries.name, mediaType: libraries.mediaType })
			.from(libraries)
			.where(inArray(libraries.id, slicedIds))
			.all();
		const rowsById = new Map(rows.map((r) => [r.id, r]));

		return {
			items: slicedIds.map((id) => {
				const row = rowsById.get(id);
				return {
					id: `hi-lib-${id}`,
					kind: 'folder' as const,
					title: row?.name ?? `Library ${id}`,
					subtitle: row?.mediaType === 'tv' ? 'TV library' : 'Movie library',
					badges: [{ label: 'No root folder', tone }],
					href: '/settings/library/libraries'
				};
			}),
			total
		};
	}

	// Root folder health issues (inaccessible, read-only, needs scan)
	if (!Array.isArray(rawDetails?.folderIds) || rawDetails.folderIds.length === 0) {
		return { items: [], total: 0 };
	}

	const allIds: string[] = rawDetails.folderIds;
	const paths: string[] = rawDetails.folderPaths ?? [];
	const total = allIds.length;
	const sliceStart = (page - 1) * limit;
	const slicedIds = allIds.slice(sliceStart, sliceStart + limit);

	const rows = db
		.select({ id: rootFolders.id, name: rootFolders.name, path: rootFolders.path })
		.from(rootFolders)
		.where(inArray(rootFolders.id, slicedIds))
		.all();
	const rowsById = new Map(rows.map((r) => [r.id, r]));
	const pathsById = new Map<string, string>();
	for (let i = 0; i < allIds.length; i++) {
		if (paths[i]) pathsById.set(allIds[i], paths[i]);
	}

	return {
		items: slicedIds.map((id) => {
			const row = rowsById.get(id);
			return {
				id: `hi-${id}`,
				kind: 'folder' as const,
				title: row?.name ?? `Folder ${id}`,
				subtitle: pathsById.get(id) ?? row?.path,
				badges: [{ label: 'Action needed', tone }],
				href: `/settings/monitoring/status/folders?folderId=${id}`
			};
		}),
		total
	};
};

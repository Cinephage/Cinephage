/**
 * GET /api/library/series/[id]/episode-groups
 * Returns available TMDB episode groups for a series and the currently selected group.
 */

import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import {
	fetchEpisodeGroups,
	buildEpisodeGroupInfoList
} from '#lib/server/metadata/EpisodeGroupService.js';

const logger = createChildLogger({ module: 'LibrarySeriesEpisodeGroupsApi', logDomain: 'scans' });

export const GET: RequestHandler = async ({ params }) => {
	try {
		const [seriesItem] = await db
			.select({
				tmdbId: series.tmdbId,
				episodeGroupId: series.episodeGroupId
			})
			.from(series)
			.where(eq(series.id, params.id));

		if (!seriesItem) {
			return Response.json({ success: false, error: 'Series not found' }, { status: 404 });
		}

		const groupsResponse = await fetchEpisodeGroups(seriesItem.tmdbId);
		const groups = buildEpisodeGroupInfoList(groupsResponse, seriesItem.episodeGroupId ?? null);

		return Response.json({
			success: true,
			episodeGroups: groups,
			selectedGroupId: seriesItem.episodeGroupId ?? null
		});
	} catch (error) {
		logger.error(
			'[EpisodeGroups] Failed to fetch episode groups',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to fetch episode groups'
			},
			{ status: 500 }
		);
	}
};

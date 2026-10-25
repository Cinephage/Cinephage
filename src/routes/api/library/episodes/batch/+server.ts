import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { episodes } from '#lib/server/db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LibraryEpisodesBatchApi', logDomain: 'scans' });

/**
 * PATCH /api/library/episodes/batch
 * Batch update episode settings (primarily monitoring)
 *
 * Body:
 * - episodeIds: string[] - Array of episode IDs to update
 * - monitored: boolean - New monitored state
 *
 * OR for updating all episodes in a series/season:
 * - seriesId: string - Update all episodes in this series
 * - seasonNumber?: number - Optionally filter to specific season
 * - monitored: boolean - New monitored state
 */
export const PATCH: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { episodeIds, seriesId, seasonNumber, monitored } = body;

		if (typeof monitored !== 'boolean') {
			return Response.json(
				{ success: false, error: 'monitored field is required and must be a boolean' },
				{ status: 400 }
			);
		}

		let updatedCount = 0;

		// Update specific episode IDs
		if (episodeIds && Array.isArray(episodeIds) && episodeIds.length > 0) {
			const result = await db
				.update(episodes)
				.set({ monitored })
				.where(inArray(episodes.id, episodeIds));

			updatedCount = result.changes;
		}
		// Update all episodes in series/season
		else if (seriesId) {
			const conditions = [eq(episodes.seriesId, seriesId)];

			if (typeof seasonNumber === 'number') {
				conditions.push(eq(episodes.seasonNumber, seasonNumber));
			}

			const result = await db
				.update(episodes)
				.set({ monitored })
				.where(and(...conditions));

			updatedCount = result.changes;
		} else {
			return Response.json(
				{ success: false, error: 'Either episodeIds or seriesId must be provided' },
				{ status: 400 }
			);
		}

		return Response.json({
			success: true,
			updatedCount
		});
	} catch (error) {
		logger.error('[API] Error batch updating episodes', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to batch update episodes'
			},
			{ status: 500 }
		);
	}
};

// Alias PUT to PATCH for convenience
export const PUT: RequestHandler = PATCH;

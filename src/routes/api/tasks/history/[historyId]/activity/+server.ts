/**
 * Task History Activity API
 *
 * GET /api/tasks/history/:historyId/activity
 * Returns the per-item activity (monitoringHistory) for a specific task run
 */

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { monitoringHistory, movies, series, episodes } from '#lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'TaskHistoryActivityApi', logDomain: 'monitoring' });

export interface ActivityItem {
	id: string;
	taskType: string;
	status: string;
	releasesFound: number;
	releaseGrabbed: string | null;
	isUpgrade: boolean;
	oldScore: number | null;
	newScore: number | null;
	errorMessage: string | null;
	executedAt: string;
	// Media info
	mediaType: 'movie' | 'episode' | 'unknown';
	mediaTitle: string;
	mediaId: string | null;
	// Episode-specific
	seasonNumber: number | null;
	episodeNumber: number | null;
	seriesTitle: string | null;
}

export const GET: RequestHandler = async ({ params }) => {
	const { historyId } = params;

	if (!historyId) {
		return Response.json({ error: 'History ID is required' }, { status: 400 });
	}

	try {
		// Fetch all monitoring history entries for this task run
		const entries = await db
			.select({
				history: monitoringHistory,
				movie: movies,
				series: series,
				episode: episodes
			})
			.from(monitoringHistory)
			.leftJoin(movies, eq(monitoringHistory.movieId, movies.id))
			.leftJoin(series, eq(monitoringHistory.seriesId, series.id))
			.leftJoin(episodes, eq(monitoringHistory.episodeId, episodes.id))
			.where(eq(monitoringHistory.taskHistoryId, historyId))
			.orderBy(desc(monitoringHistory.executedAt));

		// Transform to activity items
		const activity: ActivityItem[] = entries.map((entry) => {
			let mediaType: 'movie' | 'episode' | 'unknown' = 'unknown';
			let mediaTitle = 'Unknown';
			let mediaId: string | null = null;
			let seasonNumber: number | null = null;
			let episodeNumber: number | null = null;
			let seriesTitle: string | null = null;

			if (entry.movie) {
				mediaType = 'movie';
				mediaTitle = entry.movie.title;
				mediaId = entry.movie.id;
			} else if (entry.episode && entry.series) {
				mediaType = 'episode';
				seriesTitle = entry.series.title;
				seasonNumber = entry.episode.seasonNumber;
				episodeNumber = entry.episode.episodeNumber;
				mediaTitle = entry.episode.title || `Episode ${episodeNumber}`;
				mediaId = entry.episode.id;
			} else if (entry.series) {
				mediaType = 'episode';
				seriesTitle = entry.series.title;
				seasonNumber = entry.history.seasonNumber;
				mediaTitle = entry.series.title;
				mediaId = entry.series.id;
			}

			return {
				id: entry.history.id,
				taskType: entry.history.taskType,
				status: entry.history.status,
				releasesFound: entry.history.releasesFound ?? 0,
				releaseGrabbed: entry.history.releaseGrabbed,
				isUpgrade: entry.history.isUpgrade ?? false,
				oldScore: entry.history.oldScore,
				newScore: entry.history.newScore,
				errorMessage: entry.history.errorMessage,
				executedAt: entry.history.executedAt ?? new Date().toISOString(),
				mediaType,
				mediaTitle,
				mediaId,
				seasonNumber,
				episodeNumber,
				seriesTitle
			};
		});

		return Response.json({
			success: true,
			activity,
			total: activity.length
		});
	} catch (error) {
		logger.error({ historyId, error }, '[TaskHistoryActivity] Failed to fetch activity');
		return Response.json({ error: 'Failed to fetch activity' }, { status: 500 });
	}
};

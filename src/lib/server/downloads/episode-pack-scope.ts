/**
 * Scope resolution for season-pack episode pointers.
 *
 * RuTracker (and Kinozal) publish a season as one living topic: the author
 * re-creates the torrent as new episodes air, and a pack version is a snapshot
 * of everything available at that moment. A pointer grab therefore has to ask
 * the pack for every wanted episode it already contains, not just the episode
 * that triggered the search.
 *
 * This module answers "which episodes of this season are wanted right now":
 * monitored, missing, aired, and not already covered by an active download.
 * File matching stays in episode-pointer.ts; this only supplies the numbers.
 * The split is deliberate: matching is pure (paths in, indices out), scope is
 * the only part that reads the database.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, episodes } from '#lib/server/db/schema.js';
import { airedSeasonCondition } from '#lib/server/library/aired-episodes.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ACTIVE_DOWNLOAD_STATUSES } from '#lib/types/queue.js';

const logger = createChildLogger({ module: 'EpisodePackScope' });

export interface EpisodePackScopeEntry {
	/** Absent when the episode is not in the local library metadata. */
	episodeId?: string;
	episodeNumber: number;
}

export async function resolveEpisodePackScope(params: {
	seriesId: string;
	seasonNumber: number;
	/** Episode that triggered the grab; always kept in the returned scope. */
	targetEpisode: number;
	targetEpisodeId?: string;
}): Promise<EpisodePackScopeEntry[]> {
	const target: EpisodePackScopeEntry = {
		episodeId: params.targetEpisodeId,
		episodeNumber: params.targetEpisode
	};

	try {
		const seasonEpisodes = await db
			.select({ id: episodes.id, episodeNumber: episodes.episodeNumber })
			.from(episodes)
			.where(
				and(
					airedSeasonCondition(params.seriesId, params.seasonNumber),
					eq(episodes.hasFile, false),
					eq(episodes.monitored, true)
				)
			);

		const activeQueueRows = await db
			.select({ episodeIds: downloadQueue.episodeIds })
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.seriesId, params.seriesId),
					inArray(downloadQueue.status, [...ACTIVE_DOWNLOAD_STATUSES])
				)
			);

		const alreadyQueued = new Set<string>();
		for (const row of activeQueueRows) {
			for (const episodeId of row.episodeIds ?? []) {
				alreadyQueued.add(episodeId);
			}
		}

		const scope: EpisodePackScopeEntry[] = seasonEpisodes
			.filter((episode) => !alreadyQueued.has(episode.id))
			.map((episode) => ({ episodeId: episode.id, episodeNumber: episode.episodeNumber }));

		// The pointer's own episode is wanted by definition - the grab would not
		// be running otherwise. Keep it even when the episode row is missing from
		// the local library metadata (e.g. a season that was never refreshed).
		if (!scope.some((episode) => episode.episodeNumber === params.targetEpisode)) {
			scope.push(target);
		}

		return scope.sort((a, b) => a.episodeNumber - b.episodeNumber);
	} catch (error) {
		// Declared containment: a failed scope read must not block the grab, but
		// it is not silent. Without this log the grab quietly reverts to the
		// single-episode behaviour this module exists to fix (#663).
		logger.warn(
			{
				err: error,
				seriesId: params.seriesId,
				seasonNumber: params.seasonNumber,
				targetEpisode: params.targetEpisode
			},
			'Episode pack scope unavailable; falling back to the single pointer episode'
		);
		return [target];
	}
}

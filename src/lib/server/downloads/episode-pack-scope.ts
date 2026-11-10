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
 */

import { and, eq, inArray, lte } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, episodes } from '#lib/server/db/schema.js';
import { todayDateString } from '#lib/utils/format.js';

export interface EpisodePackScopeEntry {
	episodeId: string;
	episodeNumber: number;
}

/**
 * Queue states in which an episode is already accounted for. Anything outside
 * this list (imported, removed, failed) is free to be selected again.
 */
const ACTIVE_QUEUE_STATUSES = [
	'queued',
	'downloading',
	'stalled',
	'awaiting',
	'paused',
	'completed',
	'postprocessing',
	'importing',
	'seeding'
] as const;

export async function resolveEpisodePackScope(params: {
	seriesId: string;
	seasonNumber: number;
	/** Episode that triggered the grab; always kept in the returned scope. */
	targetEpisode: number;
	targetEpisodeId?: string;
	/** Monitor only - interactive grabs keep their single-episode semantics. */
	monitoredOnly?: boolean;
}): Promise<EpisodePackScopeEntry[]> {
	const fallback: EpisodePackScopeEntry[] = params.targetEpisodeId
		? [{ episodeId: params.targetEpisodeId, episodeNumber: params.targetEpisode }]
		: [{ episodeId: '', episodeNumber: params.targetEpisode }];

	try {
		const conditions = [
			eq(episodes.seriesId, params.seriesId),
			eq(episodes.seasonNumber, params.seasonNumber),
			eq(episodes.hasFile, false),
			lte(episodes.airDate, todayDateString())
		];
		if (params.monitoredOnly !== false) {
			conditions.push(eq(episodes.monitored, true));
		}

		const seasonEpisodes = await db
			.select({ id: episodes.id, episodeNumber: episodes.episodeNumber })
			.from(episodes)
			.where(and(...conditions));

		const activeQueueRows = await db
			.select({ episodeIds: downloadQueue.episodeIds })
			.from(downloadQueue)
			.where(
				and(
					eq(downloadQueue.seriesId, params.seriesId),
					inArray(downloadQueue.status, [...ACTIVE_QUEUE_STATUSES])
				)
			);

		const alreadyQueued = new Set<string>();
		for (const row of activeQueueRows) {
			for (const episodeId of row.episodeIds ?? []) {
				alreadyQueued.add(episodeId);
			}
		}

		const scope = seasonEpisodes
			.filter((episode) => !alreadyQueued.has(episode.id))
			.map((episode) => ({ episodeId: episode.id, episodeNumber: episode.episodeNumber }));

		// The pointer's own episode is wanted by definition - the grab would not
		// be running otherwise. Keep it even when the episode row is missing from
		// the local library metadata (e.g. a season that was never refreshed).
		if (!scope.some((episode) => episode.episodeNumber === params.targetEpisode)) {
			scope.push(fallback[0]);
		}

		return scope.sort((a, b) => a.episodeNumber - b.episodeNumber);
	} catch {
		// Scope resolution is an optimisation - never block a grab because the
		// local episode metadata could not be read.
		return fallback;
	}
}

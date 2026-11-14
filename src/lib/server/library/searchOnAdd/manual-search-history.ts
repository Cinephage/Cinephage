/**
 * Records manually-triggered "Auto-grab" attempts (movie/episode/season/
 * series-missing buttons on a library detail page - NOT the Interactive
 * Search modal, which stays fully supervised and out of scope here) into
 * monitoringHistory, tagged taskType 'manual' so they're distinguishable
 * from scheduled runs.
 */

import { db } from '#lib/server/db/index.js';
import { monitoringHistory, movies, episodes } from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import type { GrabResult, AutoSearchItemResult } from './types.js';

const NO_RESULTS_PATTERN = /^no (suitable )?releases found|^no upgrades found/i;

function deriveStatus(result: GrabResult): 'grabbed' | 'no_results' | 'error' {
	if (result.success) return 'grabbed';
	if (result.error && NO_RESULTS_PATTERN.test(result.error)) return 'no_results';
	return 'error';
}

export interface ManualSearchTarget {
	movieId?: string;
	seriesId?: string;
	seasonNumber?: number;
	episodeId?: string;
}

export async function recordManualSearchAttempt(
	target: ManualSearchTarget,
	result: GrabResult
): Promise<void> {
	const executedAt = new Date().toISOString();
	const status = deriveStatus(result);

	await db.insert(monitoringHistory).values({
		taskType: 'manual',
		movieId: target.movieId,
		seriesId: target.seriesId,
		seasonNumber: target.seasonNumber,
		episodeId: target.episodeId,
		status,
		releasesFound: status === 'grabbed' ? 1 : 0,
		releaseGrabbed: result.releaseName,
		queueItemId: result.queueItemId,
		errorMessage: result.error,
		indexerId: result.indexerId,
		indexerName: result.indexerName,
		indexersQueried: result.indexersQueried,
		executedAt
	});

	if (target.movieId) {
		await db
			.update(movies)
			.set({ lastSearchTime: executedAt })
			.where(eq(movies.id, target.movieId));
	}
	if (target.episodeId) {
		await db
			.update(episodes)
			.set({ lastSearchTime: executedAt })
			.where(eq(episodes.id, target.episodeId));
	}
}

/**
 * Same as recordManualSearchAttempt, but for the multi-item results array
 * returned by searchForMissingEpisodes/searchBulkEpisodes ('missing' and
 * 'bulk' auto-search types). Each AutoSearchItemResult.itemId is an episode
 * id (even for a season-pack grab, where it's a representative episode) -
 * for pack grabs, the row is logged against the season instead of that one
 * episode, same convention the automatic missing-content search uses.
 */
export async function recordManualMultiItemResults(
	seriesId: string,
	results: AutoSearchItemResult[]
): Promise<void> {
	if (results.length === 0) return;

	const episodeRows = await db
		.select({ id: episodes.id, seasonNumber: episodes.seasonNumber })
		.from(episodes)
		.where(
			inArray(
				episodes.id,
				results.map((r) => r.itemId)
			)
		)
		.all();
	const seasonByEpisodeId = new Map(episodeRows.map((e) => [e.id, e.seasonNumber]));

	for (const item of results) {
		// No separate 'found' status - a release found but not grabbed is no
		// more actionable than no_results, so it's folded in rather than left
		// with no explanation of its own (releasesFound still reflects it).
		const status: 'grabbed' | 'no_results' | 'error' = item.grabbed
			? 'grabbed'
			: item.error && !NO_RESULTS_PATTERN.test(item.error)
				? 'error'
				: 'no_results';

		await db.insert(monitoringHistory).values({
			taskType: 'manual',
			seriesId,
			seasonNumber: item.wasPackGrab ? seasonByEpisodeId.get(item.itemId) : undefined,
			episodeId: item.wasPackGrab ? undefined : item.itemId,
			status,
			releasesFound: status === 'grabbed' || item.found ? 1 : 0,
			releaseGrabbed: item.releaseName,
			errorMessage: item.error,
			indexerId: item.indexerId,
			indexerName: item.indexerName,
			indexersQueried: item.indexersQueried,
			executedAt: new Date().toISOString()
		});

		if (!item.wasPackGrab) {
			await db
				.update(episodes)
				.set({ lastSearchTime: new Date().toISOString() })
				.where(eq(episodes.id, item.itemId));
		}
	}
}

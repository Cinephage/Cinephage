/**
 * MonitoredSpecification
 *
 * Checks if content is monitored for automated searching.
 * For TV shows, implements cascading monitoring logic:
 * - Episode is monitored if series.monitored AND season.monitored AND episode.monitored
 */

import { db } from '#lib/server/db/index.js';
import { seasons } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import type {
	IMonitoringSpecification,
	MovieContext,
	EpisodeContext,
	SpecificationResult,
	ReleaseCandidate
} from './types.js';
import { reject, accept, RejectionReason } from './types.js';

const logger = createChildLogger({ module: 'MonitoredSpecification', logDomain: 'monitoring' });

/**
 * Check if a movie is monitored
 */
export class MovieMonitoredSpecification implements IMonitoringSpecification<MovieContext> {
	async isSatisfied(
		context: MovieContext,
		_release?: ReleaseCandidate
	): Promise<SpecificationResult> {
		if (!context.movie.monitored) {
			return reject(RejectionReason.NOT_MONITORED);
		}

		return accept();
	}
}

/**
 * Check if an episode is monitored (with cascading logic)
 */
export class EpisodeMonitoredSpecification implements IMonitoringSpecification<EpisodeContext> {
	async isSatisfied(
		context: EpisodeContext,
		_release?: ReleaseCandidate
	): Promise<SpecificationResult> {
		// Check series-level monitoring
		if (!context.series.monitored) {
			return reject(RejectionReason.SERIES_NOT_MONITORED);
		}

		// Check episode-level monitoring
		if (!context.episode.monitored) {
			return reject(RejectionReason.NOT_MONITORED);
		}

		// Check season-level monitoring (need to fetch from DB). A missing or
		// dangling seasonId is a data-integrity problem, not "no opinion", failing
		// open here let episodes bypass an unmonitored season entirely and get
		// endlessly re-searched/re-grabbed even though the user turned them off.
		// Fail closed instead: reject and log so it surfaces as a fixable bug
		// rather than silently resurrecting downloads.
		if (!context.episode.seasonId) {
			logger.warn(
				{ episodeId: context.episode.id, seriesId: context.series.id },
				'[MonitoredSpecification] Episode has no seasonId; treating as unmonitored'
			);
			return reject(RejectionReason.SEASON_LINK_MISSING);
		}

		const season = await db.query.seasons.findFirst({
			where: eq(seasons.id, context.episode.seasonId)
		});

		if (!season) {
			logger.warn(
				{ episodeId: context.episode.id, seasonId: context.episode.seasonId },
				'[MonitoredSpecification] Episode references a season that no longer exists; treating as unmonitored'
			);
			return reject(RejectionReason.SEASON_LINK_MISSING);
		}

		if (!season.monitored) {
			return reject(RejectionReason.SEASON_NOT_MONITORED);
		}

		return accept();
	}
}

/**
 * Convenience function to check if a movie is monitored
 */
export async function isMovieMonitored(context: MovieContext): Promise<boolean> {
	const spec = new MovieMonitoredSpecification();
	const result = await spec.isSatisfied(context);
	return result.accepted;
}

/**
 * Convenience function to check if an episode is monitored
 */
export async function isEpisodeMonitored(context: EpisodeContext): Promise<boolean> {
	const spec = new EpisodeMonitoredSpecification();
	const result = await spec.isSatisfied(context);
	return result.accepted;
}

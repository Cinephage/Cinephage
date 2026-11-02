/**
 * NewEpisodeSpecification
 *
 * Checks if an episode has recently aired (within the monitoring interval)
 * and doesn't have a file yet. Used by the new episode monitoring task.
 */

import type {
	IMonitoringSpecification,
	EpisodeContext,
	SpecificationResult,
	ReleaseCandidate
} from './types.js';
import { reject, accept, RejectionReason } from './types.js';

/**
 * How far back to look for newly aired episodes, in hours. Deliberately fixed
 * and independent of the task's scheduling interval - the interval controls
 * how often the check runs, not how wide its air-date window is.
 */
export const NEW_EPISODE_LOOKBACK_HOURS = 48;

export interface NewEpisodeOptions {
	/**
	 * How far back to look for new episodes (in hours).
	 * Defaults to NEW_EPISODE_LOOKBACK_HOURS; override only for tests.
	 */
	lookbackHours?: number;
}

/**
 * Check if an episode is newly aired and missing
 */
export class NewEpisodeSpecification implements IMonitoringSpecification<EpisodeContext> {
	constructor(private options: NewEpisodeOptions) {}

	async isSatisfied(
		context: EpisodeContext,
		_release?: ReleaseCandidate
	): Promise<SpecificationResult> {
		// Must not have a file yet
		if (context.episode.hasFile) {
			return reject(RejectionReason.ALREADY_HAS_FILE);
		}

		// Must have an air date
		if (!context.episode.airDate) {
			return reject('no_air_date');
		}

		const airDate = new Date(context.episode.airDate + 'T00:00:00');
		const now = new Date();

		// Must have already aired
		if (airDate > now) {
			return reject(RejectionReason.NOT_YET_AIRED);
		}

		// Check if aired within the lookback window
		const lookbackHours = this.options.lookbackHours ?? NEW_EPISODE_LOOKBACK_HOURS;
		const hoursAgo = lookbackHours * 60 * 60 * 1000; // Convert to milliseconds
		const cutoffDate = new Date(now.getTime() - hoursAgo);

		if (airDate < cutoffDate) {
			return reject('aired_too_long_ago');
		}

		// Episode aired recently and doesn't have a file
		return accept();
	}
}

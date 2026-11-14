/**
 * Failure Cap Specification
 *
 * Stops an item from being retried forever after too many consecutive
 * failed grab/import attempts, regardless of which release was tried each
 * time. The existing search cooldown and release blocklist both operate
 * per-release - neither stops a search from grabbing a *different*,
 * not-yet-tried release every cycle, forever, if the correct release keeps
 * failing (e.g. an indexer removed the files after the fact). This
 * specification is the circuit breaker for that case.
 */

import { reject, accept } from './types.js';
import type {
	IMonitoringSpecification,
	MovieContext,
	EpisodeContext,
	SpecificationResult
} from './types.js';

/**
 * Default max consecutive failures before an item is skipped. Not
 * user-configurable - matches this codebase's existing precedent for
 * similar retry ceilings (e.g. MAX_IMPORT_ATTEMPTS), which are also bare
 * constants with no settings UI.
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Ceiling for the escalating backoff below - "short" deliberately: a hard
 * stop already exists at DEFAULT_MAX_CONSECUTIVE_FAILURES, so this only
 * needs to slow repeated failures down before that cap bites, not replace
 * it with a long-running throttle.
 */
export const MAX_BACKOFF_HOURS = 48;

/**
 * Effective search-cooldown hours for an item with `consecutiveFailureCount`
 * failures in a row: doubles the normal cooldown per failure, capped at
 * MAX_BACKOFF_HOURS. Zero failures returns `baseHours` unchanged, so an
 * item with no failure history keeps the configured interval exactly as
 * before this existed.
 *
 * Scoped to the missing-content search path only, matching
 * FailureCapSpecification's own scope - upgrade/cutoff/new-episode searches
 * keep their flat cooldown.
 */
export function backoffCooldownHours(baseHours: number, consecutiveFailureCount: number): number {
	if (consecutiveFailureCount <= 0) return baseHours;
	return Math.min(baseHours * Math.pow(2, consecutiveFailureCount), MAX_BACKOFF_HOURS);
}

/**
 * MovieFailureCapSpecification
 *
 * Checks whether a movie has failed too many consecutive grab/import
 * attempts and should stop being auto-searched until a human intervenes.
 */
export class MovieFailureCapSpecification implements IMonitoringSpecification<MovieContext> {
	private maxFailures: number;

	constructor(maxFailures: number = DEFAULT_MAX_CONSECUTIVE_FAILURES) {
		this.maxFailures = maxFailures;
	}

	async isSatisfied(context: MovieContext): Promise<SpecificationResult> {
		const { movie } = context;

		if (movie.consecutiveFailureCount >= this.maxFailures) {
			return reject(
				`Max consecutive failures reached (${this.maxFailures}) - auto-search paused for this item, run the task manually to retry`
			);
		}

		return accept();
	}
}

/**
 * EpisodeFailureCapSpecification
 *
 * Checks whether an episode has failed too many consecutive grab/import
 * attempts and should stop being auto-searched until a human intervenes.
 */
export class EpisodeFailureCapSpecification implements IMonitoringSpecification<EpisodeContext> {
	private maxFailures: number;

	constructor(maxFailures: number = DEFAULT_MAX_CONSECUTIVE_FAILURES) {
		this.maxFailures = maxFailures;
	}

	async isSatisfied(context: EpisodeContext): Promise<SpecificationResult> {
		const { episode } = context;

		if (episode.consecutiveFailureCount >= this.maxFailures) {
			return reject(
				`Max consecutive failures reached (${this.maxFailures}) - auto-search paused for this item, run the task manually to retry`
			);
		}

		return accept();
	}
}

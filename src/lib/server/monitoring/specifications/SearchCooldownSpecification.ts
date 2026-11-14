/**
 * Search Cooldown Specification
 *
 * Prevents hammering indexers by enforcing a cooldown period between searches
 * for the same item. Similar to Radarr's SearchCutoffService.
 *
 * This specification ensures we don't repeatedly search for items that were
 * recently searched, reducing unnecessary load on indexers.
 */

import { reject, accept } from './types.js';
import type {
	IMonitoringSpecification,
	MovieContext,
	EpisodeContext,
	SpecificationResult
} from './types.js';

/**
 * Default search cooldown in hours
 * Used as fallback when no task-derived cooldown is provided.
 */
const DEFAULT_SEARCH_COOLDOWN_HOURS = 12;

/**
 * Minimum search cooldown in hours
 * Never search more frequently than this
 */
const MIN_SEARCH_COOLDOWN_HOURS = 1;

/**
 * Maximum search cooldown in hours
 * Prevent excessively long suppression windows.
 */
const MAX_SEARCH_COOLDOWN_HOURS = 24;

/**
 * Check if enough time has passed since the last search
 */
function hasSearchCooldownPassed(
	lastSearchTime: string | null | undefined,
	cooldownHours: number = DEFAULT_SEARCH_COOLDOWN_HOURS
): { passed: boolean; hoursRemaining: number } {
	if (!lastSearchTime) {
		// Never searched before
		return { passed: true, hoursRemaining: 0 };
	}

	const lastSearch = new Date(lastSearchTime);
	const now = new Date();
	const hoursSinceSearch = (now.getTime() - lastSearch.getTime()) / (1000 * 60 * 60);

	const effectiveCooldown = Math.min(
		MAX_SEARCH_COOLDOWN_HOURS,
		Math.max(cooldownHours, MIN_SEARCH_COOLDOWN_HOURS)
	);
	const passed = hoursSinceSearch >= effectiveCooldown;
	const hoursRemaining = passed ? 0 : effectiveCooldown - hoursSinceSearch;

	return { passed, hoursRemaining: Math.round(hoursRemaining * 10) / 10 };
}

/**
 * MovieSearchCooldownSpecification
 *
 * Checks if a movie has been searched recently and should be skipped.
 */
export class MovieSearchCooldownSpecification implements IMonitoringSpecification<MovieContext> {
	private cooldownHours: number;

	constructor(cooldownHours: number = DEFAULT_SEARCH_COOLDOWN_HOURS) {
		this.cooldownHours = cooldownHours;
	}

	async isSatisfied(context: MovieContext): Promise<SpecificationResult> {
		const { movie } = context;

		const { passed, hoursRemaining } = hasSearchCooldownPassed(
			movie.lastSearchTime,
			this.cooldownHours
		);

		if (!passed) {
			return reject(`Recently searched, cooldown: ${hoursRemaining}h remaining`);
		}

		return accept();
	}
}

/**
 * EpisodeSearchCooldownSpecification
 *
 * Checks if an episode has been searched recently and should be skipped.
 */
export class EpisodeSearchCooldownSpecification implements IMonitoringSpecification<EpisodeContext> {
	private cooldownHours: number;

	constructor(cooldownHours: number = DEFAULT_SEARCH_COOLDOWN_HOURS) {
		this.cooldownHours = cooldownHours;
	}

	async isSatisfied(context: EpisodeContext): Promise<SpecificationResult> {
		const { episode } = context;

		const { passed, hoursRemaining } = hasSearchCooldownPassed(
			episode.lastSearchTime,
			this.cooldownHours
		);

		if (!passed) {
			return reject(`Recently searched, cooldown: ${hoursRemaining}h remaining`);
		}

		return accept();
	}
}

/**
 * Helper to format next search time for UI display
 */
export function getNextSearchTime(
	lastSearchTime: string | null | undefined,
	cooldownHours: number = DEFAULT_SEARCH_COOLDOWN_HOURS
): Date | null {
	if (!lastSearchTime) {
		return null;
	}

	const lastSearch = new Date(lastSearchTime);
	const effectiveCooldown = Math.min(
		MAX_SEARCH_COOLDOWN_HOURS,
		Math.max(cooldownHours, MIN_SEARCH_COOLDOWN_HOURS)
	);
	const nextSearch = new Date(lastSearch.getTime() + effectiveCooldown * 60 * 60 * 1000);

	// If next search is in the past, return null (can search now)
	if (nextSearch <= new Date()) {
		return null;
	}

	return nextSearch;
}

/**
 * Default export for convenience
 */
export const DEFAULT_COOLDOWN_HOURS = DEFAULT_SEARCH_COOLDOWN_HOURS;

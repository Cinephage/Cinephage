/**
 * Auto-Search Paused Specification
 *
 * Lets a user pause auto-search for a single item from the Searches tab's
 * detail drawer. Deliberately separate from `monitored` (which gates far
 * more than just searching - library browsing, counts, etc.) and from the
 * failure cap (FailureCapSpecification, which is missing-content-search-only
 * and would make "user paused it" indistinguishable from "it organically hit
 * the cap"). A user-initiated pause means "don't auto-search this item,
 * period" across every search task type, so this spec is checked outside any
 * `ignoreCooldown` bypass - unlike the cooldown/failure-cap checks, a manual
 * "Run Now" on the whole task should still respect an explicit per-item
 * pause. Searching the item directly (the drawer's own "Search Now" action)
 * bypasses the specification pipeline entirely, same as today's per-item
 * auto-search endpoints, so it still works while paused.
 */

import { reject, accept } from './types.js';
import type {
	IMonitoringSpecification,
	MovieContext,
	EpisodeContext,
	SpecificationResult
} from './types.js';

export class MovieAutoSearchPausedSpecification implements IMonitoringSpecification<MovieContext> {
	async isSatisfied(context: MovieContext): Promise<SpecificationResult> {
		if (context.movie.autoSearchPaused) {
			return reject('Auto-search paused for this item');
		}
		return accept();
	}
}

export class EpisodeAutoSearchPausedSpecification implements IMonitoringSpecification<EpisodeContext> {
	async isSatisfied(context: EpisodeContext): Promise<SpecificationResult> {
		if (context.episode.autoSearchPaused) {
			return reject('Auto-search paused for this item');
		}
		return accept();
	}
}

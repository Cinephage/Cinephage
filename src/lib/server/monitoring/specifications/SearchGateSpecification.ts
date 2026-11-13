/**
 * Search Gate Specification
 *
 * The one rule that answers "may this item be searched right now?". It composes
 * the two time-based gates that used to be separate concerns at the call site:
 *
 *  1. the retry budget (`search_state`): attempt cap, backoff and per-item pause;
 *  2. the cooldown (`last_search_time`): never hammer an indexer.
 *
 * They are checked in that order so a spent budget is reported as such instead
 * of being masked by a cooldown message. Composing them here means every
 * automatic search path - missing, upgrade, cutoff, new episode - gets the same
 * behaviour without each loop re-implementing it, and a manual run can still
 * bypass the pair with `ignoreCooldown`.
 */
import { reject, accept } from './types.js';
import type {
	IMonitoringSpecification,
	MovieContext,
	EpisodeContext,
	SpecificationResult
} from './types.js';
import {
	evaluateSearchGate,
	getSearchPolicy,
	getSearchState,
	type SearchKind,
	type SearchPolicy
} from '../search/search-state.js';

/** Same bounds the standalone cooldown specification used. */
const DEFAULT_SEARCH_COOLDOWN_HOURS = 12;
const MIN_SEARCH_COOLDOWN_HOURS = 1;
const MAX_SEARCH_COOLDOWN_HOURS = 24;

/**
 * Policy cache. A single task run evaluates this specification once per item,
 * and a 500-item scan must not read `monitoring_settings` 500 times.
 */
let cachedPolicy: { value: SearchPolicy; at: number } | null = null;
const POLICY_TTL_MS = 5_000;

async function currentPolicy(): Promise<SearchPolicy> {
	const now = Date.now();
	if (cachedPolicy && now - cachedPolicy.at < POLICY_TTL_MS) return cachedPolicy.value;
	const value = await getSearchPolicy();
	cachedPolicy = { value, at: now };
	return value;
}

/** Test seam: drop the cached policy so a settings change is visible at once. */
export function resetSearchGatePolicyCache(): void {
	cachedPolicy = null;
}

function cooldownGate(
	lastSearchTime: string | null | undefined,
	cooldownHours: number
): { passed: boolean; reason?: string } {
	if (!lastSearchTime) return { passed: true };

	const hoursSince = (Date.now() - new Date(lastSearchTime).getTime()) / 3_600_000;
	const effective = Math.min(
		MAX_SEARCH_COOLDOWN_HOURS,
		Math.max(cooldownHours, MIN_SEARCH_COOLDOWN_HOURS)
	);
	if (hoursSince >= effective) return { passed: true };

	const remaining = Math.round((effective - hoursSince) * 10) / 10;
	return { passed: false, reason: `Recently searched, cooldown: ${remaining}h remaining` };
}

export class MovieSearchGateSpecification implements IMonitoringSpecification<MovieContext> {
	constructor(
		private readonly kind: SearchKind,
		private readonly cooldownHours: number = DEFAULT_SEARCH_COOLDOWN_HOURS
	) {}

	async isSatisfied(context: MovieContext): Promise<SpecificationResult> {
		const policy = await currentPolicy();
		const state = await getSearchState('movie', context.movie.id, this.kind);
		const gate = evaluateSearchGate(state, policy, this.kind);
		if (!gate.allowed) return reject(gate.reason ?? 'Retry limit reached');

		const cooldown = cooldownGate(context.movie.lastSearchTime, this.cooldownHours);
		if (!cooldown.passed) return reject(cooldown.reason ?? 'Search cooldown active');

		return accept();
	}
}

export class EpisodeSearchGateSpecification implements IMonitoringSpecification<EpisodeContext> {
	constructor(
		private readonly kind: SearchKind,
		private readonly cooldownHours: number = DEFAULT_SEARCH_COOLDOWN_HOURS
	) {}

	async isSatisfied(context: EpisodeContext): Promise<SpecificationResult> {
		const policy = await currentPolicy();
		const state = await getSearchState('episode', context.episode.id, this.kind);
		const gate = evaluateSearchGate(state, policy, this.kind);
		if (!gate.allowed) return reject(gate.reason ?? 'Retry limit reached');

		const cooldown = cooldownGate(context.episode.lastSearchTime, this.cooldownHours);
		if (!cooldown.passed) return reject(cooldown.reason ?? 'Search cooldown active');

		return accept();
	}
}

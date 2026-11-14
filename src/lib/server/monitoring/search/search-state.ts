/**
 * Search State - bounded retry policy for automatic release search.
 *
 * Before this module the monitoring loop had no memory of failure. An item was
 * re-queried on every scheduler run, the only gate was a fixed cooldown
 * comparison, and a failed download explicitly reset that cooldown to the epoch
 * so the next cycle searched again immediately. The result was unbounded
 * retries (50 attempts on a single episode was measured on the dev instance)
 * with no way to see them or stop them.
 *
 * This module is the single owner of three things that must not drift apart:
 *
 *  - the retry policy (attempt cap, delay, backoff, global pause),
 *  - the per-item attempt record in `search_state`,
 *  - `last_search_time` on the owning row, which the pre-existing cooldown
 *    specification still reads.
 *
 * Writing both timestamps here is deliberate: three other call sites used to
 * write `last_search_time` directly (search, file deletion, and the download
 * monitor's epoch reset), and any of them getting it wrong silently desynced
 * the limiter from the cooldown. Callers go through `recordAttempt` /
 * `resetSearchState` instead.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { episodes, monitoringSettings, movies, searchState } from '#lib/server/db/schema.js';

export type SearchOwnerType = 'movie' | 'episode';
export type SearchKind = 'missing' | 'upgrade' | 'cutoff' | 'new_episode';
export type SearchStateStatus = 'idle' | 'searching' | 'paused' | 'exhausted';
export type SearchOutcome = 'no_results' | 'rejected' | 'grabbed' | 'error' | 'skipped';

export interface SearchPolicy {
	/** Attempts allowed for missing/upgrade/cutoff before the item is left alone. */
	maxAttempts: number;
	/** Delay after the first attempt, in hours. */
	minDelayHours: number;
	/** Multiplier applied per subsequent attempt. */
	backoffMultiplier: number;
	/** Ceiling for the computed delay, in hours. */
	maxDelayHours: number;
	/** Stop every automatic search, regardless of per-item state. */
	paused: boolean;
	/** `new_episode` runs hourly and legitimately retries for days. */
	newEpisodeMaxAttempts: number;
}

/**
 * Defaults chosen so an item reaches `exhausted` in roughly two weeks of
 * escalating delays rather than never: 6 attempts at 6/12/24/48/96/168 h.
 * `new_episode` gets 48 because a release can take days to appear and that task
 * runs hourly; exhausting a show before it airs would be a regression.
 */
export const SEARCH_POLICY_DEFAULTS: SearchPolicy = {
	maxAttempts: 6,
	minDelayHours: 6,
	backoffMultiplier: 2,
	maxDelayHours: 168,
	paused: false,
	newEpisodeMaxAttempts: 48
};

const SETTING_KEYS = {
	maxAttempts: 'auto_search_max_attempts',
	minDelayHours: 'auto_search_min_delay_hours',
	backoffMultiplier: 'auto_search_backoff_multiplier',
	maxDelayHours: 'auto_search_max_delay_hours',
	paused: 'auto_search_paused',
	newEpisodeMaxAttempts: 'auto_search_new_episode_max_attempts'
} as const;

export interface SearchStateRow {
	ownerType: SearchOwnerType;
	ownerId: string;
	searchKind: SearchKind;
	status: SearchStateStatus;
	attempts: number;
	firstAttemptAt: string | null;
	lastAttemptAt: string | null;
	nextAttemptAt: string | null;
	lastOutcome: SearchOutcome | null;
	lastIndexerId: string | null;
	lastIndexerName: string | null;
	indexersQueried: number;
	pausedUntil: string | null;
	pauseReason: string | null;
	updatedAt: string;
}

export interface SearchGate {
	allowed: boolean;
	/** Why the item may not be searched now; suitable for a UI tooltip. */
	reason?: string;
	nextAttemptAt?: string | null;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read the policy from `monitoring_settings`, falling back to the defaults. */
export async function getSearchPolicy(): Promise<SearchPolicy> {
	const rows = await db
		.select()
		.from(monitoringSettings)
		.where(inArray(monitoringSettings.key, Object.values(SETTING_KEYS)));

	const map = new Map(rows.map((row) => [row.key, row.value]));

	return {
		maxAttempts: Math.floor(
			positiveNumber(map.get(SETTING_KEYS.maxAttempts), SEARCH_POLICY_DEFAULTS.maxAttempts)
		),
		minDelayHours: positiveNumber(
			map.get(SETTING_KEYS.minDelayHours),
			SEARCH_POLICY_DEFAULTS.minDelayHours
		),
		backoffMultiplier: positiveNumber(
			map.get(SETTING_KEYS.backoffMultiplier),
			SEARCH_POLICY_DEFAULTS.backoffMultiplier
		),
		maxDelayHours: positiveNumber(
			map.get(SETTING_KEYS.maxDelayHours),
			SEARCH_POLICY_DEFAULTS.maxDelayHours
		),
		paused: map.get(SETTING_KEYS.paused) === 'true',
		newEpisodeMaxAttempts: Math.floor(
			positiveNumber(
				map.get(SETTING_KEYS.newEpisodeMaxAttempts),
				SEARCH_POLICY_DEFAULTS.newEpisodeMaxAttempts
			)
		)
	};
}

/** Persist the parts of the policy that were supplied. */
export async function updateSearchPolicy(patch: Partial<SearchPolicy>): Promise<void> {
	const entries: [string, string][] = [];
	if (patch.maxAttempts !== undefined)
		entries.push([SETTING_KEYS.maxAttempts, String(patch.maxAttempts)]);
	if (patch.minDelayHours !== undefined)
		entries.push([SETTING_KEYS.minDelayHours, String(patch.minDelayHours)]);
	if (patch.backoffMultiplier !== undefined)
		entries.push([SETTING_KEYS.backoffMultiplier, String(patch.backoffMultiplier)]);
	if (patch.maxDelayHours !== undefined)
		entries.push([SETTING_KEYS.maxDelayHours, String(patch.maxDelayHours)]);
	if (patch.paused !== undefined) entries.push([SETTING_KEYS.paused, String(patch.paused)]);
	if (patch.newEpisodeMaxAttempts !== undefined)
		entries.push([SETTING_KEYS.newEpisodeMaxAttempts, String(patch.newEpisodeMaxAttempts)]);

	for (const [key, value] of entries) {
		await db
			.insert(monitoringSettings)
			.values({ key, value })
			.onConflictDoUpdate({ target: monitoringSettings.key, set: { value } });
	}
}

/** Attempts allowed for this kind. */
export function attemptBudget(kind: SearchKind, policy: SearchPolicy): number {
	return kind === 'new_episode' ? policy.newEpisodeMaxAttempts : policy.maxAttempts;
}

/**
 * Delay before the next attempt after `attempts` completed attempts.
 *
 * The first attempt is immediate; after it, the delay starts at
 * `minDelayHours` and multiplies, capped at `maxDelayHours`.
 */
export function delayHoursForAttempt(attempts: number, policy: SearchPolicy): number {
	if (attempts <= 0) return 0;
	const hours = policy.minDelayHours * Math.pow(policy.backoffMultiplier, attempts - 1);
	return Math.min(hours, policy.maxDelayHours);
}

export async function getSearchState(
	ownerType: SearchOwnerType,
	ownerId: string,
	searchKind: SearchKind
): Promise<SearchStateRow | undefined> {
	const [row] = await db
		.select()
		.from(searchState)
		.where(
			and(
				eq(searchState.ownerType, ownerType),
				eq(searchState.ownerId, ownerId),
				eq(searchState.searchKind, searchKind)
			)
		);
	return row as SearchStateRow | undefined;
}

/**
 * Decide whether an item may be searched now.
 *
 * A missing row is always allowed: the item has never been tried.
 */
export function evaluateSearchGate(
	state: SearchStateRow | undefined,
	policy: SearchPolicy,
	kind: SearchKind,
	now: number = Date.now()
): SearchGate {
	if (policy.paused) {
		return { allowed: false, reason: 'Automatic search is paused' };
	}
	if (!state) return { allowed: true };

	if (state.status === 'paused') {
		return {
			allowed: false,
			reason: state.pauseReason ?? 'Automatic search is paused for this item',
			nextAttemptAt: state.pausedUntil
		};
	}

	const budget = attemptBudget(kind, policy);
	if (state.attempts >= budget) {
		return {
			allowed: false,
			reason: `Retry limit reached (${state.attempts}/${budget}) - search again to reset it`
		};
	}

	if (state.nextAttemptAt) {
		const next = Date.parse(state.nextAttemptAt);
		if (Number.isFinite(next) && next > now) {
			return {
				allowed: false,
				reason: `Next automatic attempt at ${state.nextAttemptAt}`,
				nextAttemptAt: state.nextAttemptAt
			};
		}
	}

	return { allowed: true };
}

export interface RecordAttemptOptions {
	/** Stamp the owning row's `last_search_time` too (the default). */
	stampCooldown?: boolean;
	/** Resolved policy; read from settings when omitted. */
	policy?: SearchPolicy;
	now?: Date;
}

/**
 * Record that an attempt is starting, and arm the next allowed attempt.
 *
 * Returns the new attempt count so a caller can log or surface it.
 */
export async function recordAttempt(
	ownerType: SearchOwnerType,
	ownerId: string,
	searchKind: SearchKind,
	options: RecordAttemptOptions = {}
): Promise<number> {
	const policy = options.policy ?? (await getSearchPolicy());
	const now = options.now ?? new Date();
	const nowIso = now.toISOString();

	// Read-then-write so the returned count and the stored count agree; the
	// scheduler processes one item at a time, so there is no concurrent writer.
	const existing = await getSearchState(ownerType, ownerId, searchKind);
	const attempts = (existing?.attempts ?? 0) + 1;
	const nextAttemptAt = new Date(
		now.getTime() + delayHoursForAttempt(attempts, policy) * 3_600_000
	).toISOString();

	await db
		.insert(searchState)
		.values({
			ownerType,
			ownerId,
			searchKind,
			status: 'searching',
			attempts,
			firstAttemptAt: nowIso,
			lastAttemptAt: nowIso,
			nextAttemptAt,
			indexersQueried: 0,
			updatedAt: nowIso
		})
		.onConflictDoUpdate({
			target: [searchState.ownerType, searchState.ownerId, searchState.searchKind],
			set: {
				status: 'searching',
				attempts,
				lastAttemptAt: nowIso,
				nextAttemptAt,
				updatedAt: nowIso
			}
		});

	if (options.stampCooldown !== false) {
		await stampCooldown(ownerType, ownerId, nowIso);
	}

	return attempts;
}

async function stampCooldown(
	ownerType: SearchOwnerType,
	ownerId: string,
	nowIso: string
): Promise<void> {
	if (ownerType === 'movie') {
		await db.update(movies).set({ lastSearchTime: nowIso }).where(eq(movies.id, ownerId));
		return;
	}
	await db.update(episodes).set({ lastSearchTime: nowIso }).where(eq(episodes.id, ownerId));
}

export interface RecordOutcomeOptions {
	outcome: SearchOutcome;
	/** Resolved policy; read from settings when omitted. */
	policy?: SearchPolicy;
	indexerId?: string | null;
	indexerName?: string | null;
	indexersQueried?: number;
	now?: Date;
}

/**
 * Record how an attempt ended.
 *
 * A grab resets the counter: the item succeeded, so a later failure (a deleted
 * file, a new season) starts from zero instead of inheriting an old budget. Any
 * other outcome keeps the count and moves the row to `exhausted` once the
 * budget is spent, so the item stops being retried until something changes.
 */
export async function recordOutcome(
	ownerType: SearchOwnerType,
	ownerId: string,
	searchKind: SearchKind,
	options: RecordOutcomeOptions
): Promise<void> {
	const { outcome } = options;
	const policy = options.policy ?? (await getSearchPolicy());
	const nowIso = (options.now ?? new Date()).toISOString();
	const existing = await getSearchState(ownerType, ownerId, searchKind);
	const attempts = existing?.attempts ?? 0;

	const succeeded = outcome === 'grabbed';
	const budget = attemptBudget(searchKind, policy);
	const status: SearchStateStatus = succeeded ? 'idle' : attempts >= budget ? 'exhausted' : 'idle';

	await db
		.insert(searchState)
		.values({
			ownerType,
			ownerId,
			searchKind,
			status,
			attempts: succeeded ? 0 : attempts,
			lastOutcome: outcome,
			lastIndexerId: options.indexerId ?? null,
			lastIndexerName: options.indexerName ?? null,
			indexersQueried: options.indexersQueried ?? 0,
			updatedAt: nowIso
		})
		.onConflictDoUpdate({
			target: [searchState.ownerType, searchState.ownerId, searchState.searchKind],
			set: {
				status,
				attempts: succeeded ? 0 : attempts,
				nextAttemptAt: succeeded ? null : (existing?.nextAttemptAt ?? null),
				lastOutcome: outcome,
				lastIndexerId: options.indexerId ?? null,
				lastIndexerName: options.indexerName ?? null,
				indexersQueried: options.indexersQueried ?? 0,
				updatedAt: nowIso
			}
		});
}

export interface PauseOptions {
	reason?: string;
	/** Pause until this instant instead of indefinitely. */
	until?: Date | null;
}

/** Pause automatic search for one item and kind. */
export async function pauseSearchState(
	ownerType: SearchOwnerType,
	ownerId: string,
	searchKind: SearchKind,
	options: PauseOptions = {}
): Promise<void> {
	const nowIso = new Date().toISOString();
	await db
		.insert(searchState)
		.values({
			ownerType,
			ownerId,
			searchKind,
			status: 'paused',
			attempts: 0,
			pausedUntil: options.until ? options.until.toISOString() : null,
			pauseReason: options.reason ?? 'Paused by the user',
			updatedAt: nowIso
		})
		.onConflictDoUpdate({
			target: [searchState.ownerType, searchState.ownerId, searchState.searchKind],
			set: {
				status: 'paused',
				pausedUntil: options.until ? options.until.toISOString() : null,
				pauseReason: options.reason ?? 'Paused by the user',
				updatedAt: nowIso
			}
		});
}

/** Resume one item, clearing a pause and letting the next attempt happen now. */
export async function resumeSearchState(
	ownerType: SearchOwnerType,
	ownerId: string,
	searchKind: SearchKind
): Promise<void> {
	const nowIso = new Date().toISOString();
	await db
		.update(searchState)
		.set({
			status: 'idle',
			pausedUntil: null,
			pauseReason: null,
			nextAttemptAt: null,
			updatedAt: nowIso
		})
		.where(
			and(
				eq(searchState.ownerType, ownerType),
				eq(searchState.ownerId, ownerId),
				eq(searchState.searchKind, searchKind)
			)
		);
}

/**
 * Clear an item's retry state so the next search is immediate.
 *
 * Used when the reason for the failures changed: a file was deleted, the item
 * was re-monitored, or the user asked for a manual search.
 */
export async function resetSearchState(
	ownerType: SearchOwnerType,
	ownerId: string,
	searchKind?: SearchKind
): Promise<void> {
	const nowIso = new Date().toISOString();
	const conditions = [eq(searchState.ownerType, ownerType), eq(searchState.ownerId, ownerId)];
	if (searchKind) conditions.push(eq(searchState.searchKind, searchKind));

	await db
		.update(searchState)
		.set({
			status: 'idle',
			attempts: 0,
			nextAttemptAt: null,
			pausedUntil: null,
			pauseReason: null,
			updatedAt: nowIso
		})
		.where(and(...conditions));

	await stampCooldown(ownerType, ownerId, nowIso);
}

/** Every tracked item, most recently attempted first. */
export async function listSearchStates(): Promise<SearchStateRow[]> {
	const rows = await db.select().from(searchState);
	return (rows as SearchStateRow[]).sort((a, b) =>
		(b.lastAttemptAt ?? '').localeCompare(a.lastAttemptAt ?? '')
	);
}

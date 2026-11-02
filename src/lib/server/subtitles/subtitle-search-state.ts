/**
 * Per-requirement subtitle search backoff.
 *
 * Replaces the old per-media-item adaptive state (movies/episodes
 * `failed_subtitle_attempts`, `first_subtitle_search_at` — dropped by migration
 * 142; `last_search_time` remains for release-search cooldowns) with one row
 * per `(owner, requirement)` in `subtitle_search_state`. Granularity
 * is the point: a failing `en|forced|any` requirement no longer gates the
 * `en|regular|any` requirement for the same movie/episode, and a success on one
 * requirement does not reset the backoff of the others.
 *
 * Policy (unchanged from adaptive-searching.ts):
 * - always search for the first 21 days after the first failed attempt;
 * - after that, search at most once per 7 days.
 *
 * Callers record a failure only when a requirement was actually attempted and
 * produced no acceptable candidate; they reset on a successful download.
 */

import { db } from '#lib/server/db/index.js';
import { subtitleSearchState } from '#lib/server/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { requirementKey } from '#lib/shared/language-profile.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

const logger = createChildLogger({ module: 'SubtitleSearchState', logDomain: 'subtitles' });

export type SubtitleSearchOwnerType = 'movie' | 'episode';

/** Backoff-relevant state for one owner + requirement. */
export interface SubtitleSearchState {
	failedAttempts: number;
	firstSearchAt: string | null;
	lastSearchAt: string | null;
}

/**
 * After this many days of failed searches, switch to extended (weekly) searching.
 * Bazarr default: 3 weeks (21 days).
 */
export const ADAPTIVE_SEARCH_DELAY_DAYS = 21;

/**
 * Once in extended mode, only search again after this many days since last attempt.
 * Bazarr default: 1 week (7 days).
 */
export const ADAPTIVE_SEARCH_DELTA_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a search should run for this requirement.
 *
 * - no state / no failures / no first attempt: always active
 * - within the 21-day grace window from the first attempt: always active
 * - past it: active only once 7 days have elapsed since the last attempt
 */
export function isSearchActive(
	state: SubtitleSearchState | null | undefined,
	now: number = Date.now()
): boolean {
	if (!state) return true;

	const { failedAttempts, firstSearchAt, lastSearchAt } = state;
	if (failedAttempts === 0 || !firstSearchAt) return true;

	const firstSearchTimestamp = Date.parse(firstSearchAt);
	if (Number.isNaN(firstSearchTimestamp)) {
		logger.debug({ firstSearchAt }, '[SearchState] Cannot parse firstSearchAt, allowing search');
		return true;
	}

	// Still within the initial search window - always search.
	if (firstSearchTimestamp + ADAPTIVE_SEARCH_DELAY_DAYS * DAY_MS > now) return true;

	if (!lastSearchAt) return true;

	const lastSearchTimestamp = Date.parse(lastSearchAt);
	if (Number.isNaN(lastSearchTimestamp)) {
		logger.debug({ lastSearchAt }, '[SearchState] Cannot parse lastSearchAt, allowing search');
		return true;
	}

	return lastSearchTimestamp + ADAPTIVE_SEARCH_DELTA_DAYS * DAY_MS <= now;
}

/**
 * Filter requirements down to those whose backoff window is open.
 *
 * The single eligibility gate shared by every search path (scheduled task,
 * auto-search single/batch, import triggers): requirements with no recorded
 * state are always eligible; failures within the grace window stay active;
 * extended-mode requirements only re-search after the weekly delta.
 */
export async function filterSearchEligible(
	ownerType: SubtitleSearchOwnerType,
	ownerId: string,
	requirements: SubtitleRequirement[]
): Promise<SubtitleRequirement[]> {
	const states = await getSearchStates(ownerType, ownerId);
	return requirements.filter((requirement) =>
		isSearchActive(states.get(requirementKey(requirement)))
	);
}

/** All requirement states for an owner, keyed by requirement key. */
export async function getSearchStates(
	ownerType: SubtitleSearchOwnerType,
	ownerId: string
): Promise<Map<string, SubtitleSearchState>> {
	const rows = await db
		.select()
		.from(subtitleSearchState)
		.where(
			and(eq(subtitleSearchState.ownerType, ownerType), eq(subtitleSearchState.ownerId, ownerId))
		);

	return new Map(
		rows.map((row) => [
			row.requirementKey,
			{
				failedAttempts: row.failedAttempts,
				firstSearchAt: row.firstSearchAt,
				lastSearchAt: row.lastSearchAt
			} satisfies SubtitleSearchState
		])
	);
}

/**
 * Record one failed attempt for a single requirement. Increments the counter,
 * stamps `firstSearchAt` on the first failure and `lastSearchAt` every time.
 */
export async function recordSearchFailure(
	ownerType: SubtitleSearchOwnerType,
	ownerId: string,
	requirementKey: string,
	now: Date = new Date()
): Promise<void> {
	const nowIso = now.toISOString();

	await db
		.insert(subtitleSearchState)
		.values({
			ownerType,
			ownerId,
			requirementKey,
			failedAttempts: 1,
			firstSearchAt: nowIso,
			lastSearchAt: nowIso
		})
		.onConflictDoUpdate({
			target: [
				subtitleSearchState.ownerType,
				subtitleSearchState.ownerId,
				subtitleSearchState.requirementKey
			],
			set: {
				failedAttempts: sql`${subtitleSearchState.failedAttempts} + 1`,
				firstSearchAt: sql`coalesce(${subtitleSearchState.firstSearchAt}, ${nowIso})`,
				lastSearchAt: nowIso
			}
		});
}

/**
 * Reset the backoff for a single requirement after a successful download:
 * clears the failure streak while keeping `lastSearchAt` current.
 */
export async function resetSearchFailure(
	ownerType: SubtitleSearchOwnerType,
	ownerId: string,
	requirementKey: string,
	now: Date = new Date()
): Promise<void> {
	const nowIso = now.toISOString();

	await db
		.insert(subtitleSearchState)
		.values({
			ownerType,
			ownerId,
			requirementKey,
			failedAttempts: 0,
			firstSearchAt: null,
			lastSearchAt: nowIso
		})
		.onConflictDoUpdate({
			target: [
				subtitleSearchState.ownerType,
				subtitleSearchState.ownerId,
				subtitleSearchState.requirementKey
			],
			set: {
				failedAttempts: 0,
				firstSearchAt: null,
				lastSearchAt: nowIso
			}
		});
}

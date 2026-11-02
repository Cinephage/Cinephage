/**
 * Single authority for rebuilding a series' seasons and episodes.
 *
 * Add, edit, and refresh each used to hand-roll the same rebuild against
 * unvalidated TMDB episode-group data with bare bulk inserts and no
 * transaction. TMDB groups are community content of wildly varying quality,
 * and every failure mode was silent: an empty group added the series with
 * zero seasons/episodes, one duplicate episode key aborted the whole
 * episode insert after the seasons had committed, and a transient TMDB 404
 * on refresh silently renumbered the series and relabelled its files.
 *
 * Contract, enforced here in one place:
 *  1. Group data is untrusted. A fetched group whose plan is empty or
 *     contains duplicate (season, episode) keys is rejected in favour of
 *     default TMDB ordering — the plan is never written as-is.
 *  2. Scheme stability. Refreshes pass `selection: 'stored-only'`: the
 *     stored scheme is never silently swapped. A stored group that cannot
 *     be fetched resolves to 'group-unavailable' so the caller can skip the
 *     rebuild (keeping the current numbering) instead of renumbering.
 *  3. Writes are atomic. Wipe and insert share one transaction, so a
 *     failure can never strand a half-rebuilt series.
 */

import { eq } from 'drizzle-orm';

import { db } from '#lib/server/db/index.js';
import { episodes, seasons } from '#lib/server/db/schema.js';
import { tmdb } from '#lib/server/tmdb.js';
import {
	autoSelectEpisodeGroup,
	buildSeasonsAndEpisodesFromGroup,
	findPlanConflicts
} from '#lib/server/metadata/EpisodeGroupService.js';
import type { EpisodeGroup, Season } from '#lib/types/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'SeriesEpisodePlan', logDomain: 'system' });

type TxCallback = Parameters<typeof db.transaction>[0];
type TxLike = Parameters<TxCallback>[0];

/** A rebuild plan: rows ready to insert, without season/episode IDs. */
export interface SeriesEpisodePlan {
	seasons: (typeof seasons.$inferInsert)[];
	episodes: (typeof episodes.$inferInsert)[];
}

/** Why an episode-group plan was rejected in favour of default ordering. */
export type GroupFallbackReason = 'group-empty' | 'group-numbering-conflict' | 'no-suitable-group';

export type EpisodePlanResolution =
	| { kind: 'episode-group'; groupId: string; plan: SeriesEpisodePlan }
	| { kind: 'default-ordering'; fallbackReason?: GroupFallbackReason }
	/** Stored group unfetchable under 'stored-only': caller must keep the current rows. */
	| { kind: 'group-unavailable' };

export interface ResolveEpisodePlanOptions {
	seriesId: string;
	tmdbId: number;
	/** Ordering persisted on the series row (null/undefined = default TMDB ordering). */
	storedEpisodeGroupId: string | null | undefined;
	/**
	 * 'auto' may auto-select a group when nothing is stored (series add).
	 * 'stored-only' never changes the scheme (refresh).
	 */
	selection: 'auto' | 'stored-only';
}

interface EvaluatedGroupPlan {
	plan: SeriesEpisodePlan | null;
	reason?: Exclude<GroupFallbackReason, 'no-suitable-group'>;
}

function evaluateGroupPlan(seriesId: string, group: EpisodeGroup): EvaluatedGroupPlan {
	const { seasonValues, episodeValues } = buildSeasonsAndEpisodesFromGroup(seriesId, group);
	if (seasonValues.length === 0 || episodeValues.length === 0) {
		return { plan: null, reason: 'group-empty' };
	}
	const conflicts = findPlanConflicts(episodeValues);
	if (conflicts.length > 0) {
		logger.warn(
			{ seriesId, groupId: group.id, conflicts },
			'[SeriesEpisodePlan] Episode group carries duplicate season/episode keys; rejecting it'
		);
		return { plan: null, reason: 'group-numbering-conflict' };
	}
	return { plan: { seasons: seasonValues, episodes: episodeValues } };
}

/**
 * Fetch one specific group and validate its plan — no fallbacks, no
 * auto-selection. Used for explicit user choices (the edit modal) and as
 * the building block of {@link resolveEpisodeGroupPlan}.
 */
export async function fetchValidatedGroupPlan(
	seriesId: string,
	groupId: string
): Promise<
	| { ok: true; groupId: string; plan: SeriesEpisodePlan }
	| { ok: false; reason: 'fetch-failed' | GroupFallbackReason }
> {
	try {
		const group = await tmdb.getEpisodeGroup(groupId);
		const evaluated = evaluateGroupPlan(seriesId, group);
		if (evaluated.plan) {
			return { ok: true, groupId, plan: evaluated.plan };
		}
		return { ok: false, reason: evaluated.reason ?? 'group-empty' };
	} catch (err) {
		logger.warn(
			{ seriesId, groupId, err: err instanceof Error ? err.message : String(err) },
			'[SeriesEpisodePlan] Episode group could not be fetched from TMDB'
		);
		return { ok: false, reason: 'fetch-failed' };
	}
}

/**
 * Decide the ordering scheme for a series and produce its plan. Network
 * only — nothing is written; hand the plan to {@link persistEpisodePlan}.
 */
export async function resolveEpisodeGroupPlan(
	options: ResolveEpisodePlanOptions
): Promise<EpisodePlanResolution> {
	const stored = options.storedEpisodeGroupId ?? null;

	if (stored) {
		const result = await fetchValidatedGroupPlan(options.seriesId, stored);
		if (result.ok) {
			return { kind: 'episode-group', groupId: result.groupId, plan: result.plan };
		}
		if (result.reason !== 'fetch-failed') {
			logger.warn(
				{ seriesId: options.seriesId, groupId: stored, reason: result.reason },
				'[SeriesEpisodePlan] Stored episode group is unusable; falling back to default TMDB ordering'
			);
			return { kind: 'default-ordering', fallbackReason: result.reason };
		}
		if (options.selection === 'stored-only') {
			// A transient TMDB failure must not renumber the series and
			// relabel its files. The caller keeps the current rows.
			logger.warn(
				{ seriesId: options.seriesId, groupId: stored },
				'[SeriesEpisodePlan] Stored episode group could not be fetched; keeping current numbering'
			);
			return { kind: 'group-unavailable' };
		}
		logger.warn(
			{ groupId: stored },
			'[SeriesEpisodePlan] Stored episode group no longer available, re-selecting'
		);
	} else if (options.selection === 'stored-only') {
		// Refreshing a default-ordering series stays default ordering — never
		// let a refresh introduce a scheme the user did not choose.
		return { kind: 'default-ordering' };
	}

	// Auto-selection (series add).
	try {
		const groupsResponse = await tmdb.getEpisodeGroups(options.tmdbId);
		const autoSelected = autoSelectEpisodeGroup(groupsResponse.results);
		if (!autoSelected) {
			return { kind: 'default-ordering', fallbackReason: 'no-suitable-group' };
		}
		const result = await fetchValidatedGroupPlan(options.seriesId, autoSelected.id);
		if (result.ok) {
			return { kind: 'episode-group', groupId: result.groupId, plan: result.plan };
		}
		const reason = result.reason === 'fetch-failed' ? 'no-suitable-group' : result.reason;
		logger.warn(
			{ seriesId: options.seriesId, groupId: autoSelected.id, reason },
			'[SeriesEpisodePlan] Auto-selected episode group is unusable; using default TMDB ordering'
		);
		return { kind: 'default-ordering', fallbackReason: reason };
	} catch (err) {
		logger.warn(
			{ tmdbId: options.tmdbId, err: err instanceof Error ? err.message : String(err) },
			'[SeriesEpisodePlan] Failed to fetch episode groups, using default TMDB ordering'
		);
		return { kind: 'default-ordering', fallbackReason: 'no-suitable-group' };
	}
}

export interface SeasonSummaryInput {
	season_number: number;
	name?: string | null;
	overview?: string | null;
	poster_path?: string | null;
	air_date?: string | null;
	episode_count?: number | null;
}

export interface DefaultOrderingPlanOptions {
	seriesId: string;
	seasonsSummary: SeasonSummaryInput[];
	/** Fetches one season's full episode list; return null to count as failed. */
	fetchSeason(seasonNumber: number): Promise<Season | null>;
	assignSeasonMonitored(seasonNumber: number, isSpecials: boolean): boolean;
	assignEpisodeMonitored(input: {
		seasonNumber: number;
		episodeNumber: number;
		airDate: string | null;
		seasonMonitored: boolean;
	}): boolean;
	/** Pause between season fetches to stay gentle with TMDB (default 0). */
	paceMs?: number;
}

export interface DefaultOrderingPlanResult {
	plan: SeriesEpisodePlan;
	/**
	 * Seasons whose episode list could not be fetched. The season row is
	 * still created (a later refresh fills it), but callers should surface
	 * these instead of letting the gap go unnoticed.
	 */
	failedSeasonNumbers: number[];
}

/**
 * Build a default TMDB-ordering plan. Network only — per-season fetches
 * happen here, before any destructive write, so a TMDB outage can never
 * leave the series wiped.
 */
export async function buildDefaultOrderingPlan(
	options: DefaultOrderingPlanOptions
): Promise<DefaultOrderingPlanResult> {
	const plan: SeriesEpisodePlan = { seasons: [], episodes: [] };
	const failedSeasonNumbers: number[] = [];

	for (const summary of options.seasonsSummary) {
		const isSpecials = summary.season_number === 0;
		const seasonMonitored = options.assignSeasonMonitored(summary.season_number, isSpecials);

		plan.seasons.push({
			seriesId: options.seriesId,
			seasonNumber: summary.season_number,
			name: summary.name ?? `Season ${summary.season_number}`,
			overview: summary.overview ?? null,
			posterPath: summary.poster_path ?? null,
			airDate: summary.air_date ?? null,
			monitored: seasonMonitored,
			episodeCount: summary.episode_count ?? 0,
			episodeFileCount: 0
		});

		let season: Season | null;
		try {
			season = await options.fetchSeason(summary.season_number);
		} catch {
			season = null;
		}

		if (season?.episodes && season.episodes.length > 0) {
			for (const ep of season.episodes) {
				plan.episodes.push({
					seriesId: options.seriesId,
					seasonNumber: ep.season_number,
					tmdbId: ep.id,
					episodeNumber: ep.episode_number,
					title: ep.name,
					overview: ep.overview,
					airDate: ep.air_date,
					runtime: ep.runtime,
					monitored: options.assignEpisodeMonitored({
						seasonNumber: ep.season_number,
						episodeNumber: ep.episode_number,
						airDate: ep.air_date ?? null,
						seasonMonitored
					}),
					hasFile: false
				});
			}
		} else {
			failedSeasonNumbers.push(summary.season_number);
		}

		if (options.paceMs && options.paceMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, options.paceMs));
		}
	}

	return { plan, failedSeasonNumbers };
}

/**
 * Write a plan inside an existing transaction. With `wipe`, existing
 * seasons and episodes are removed in the same transaction that inserts
 * the replacements, so a failure anywhere leaves the previous state
 * untouched instead of a half-rebuilt series. Plan rows are stamped with
 * `seriesId`, so plans may have been built with a provisional ID.
 */
export function persistEpisodePlanIn(
	tx: TxLike,
	seriesId: string,
	plan: SeriesEpisodePlan,
	options: { wipe: boolean }
): void {
	if (options.wipe) {
		tx.delete(episodes).where(eq(episodes.seriesId, seriesId)).run();
		tx.delete(seasons).where(eq(seasons.seriesId, seriesId)).run();
	}

	if (plan.seasons.length === 0) {
		return;
	}

	tx.insert(seasons)
		.values(plan.seasons.map((s) => ({ ...s, seriesId })))
		.onConflictDoNothing()
		.run();
	// Plan rows do not carry season IDs; link them from the rows that now
	// exist (inserted above, or pre-existing when not wiping).
	const seasonRows = tx
		.select({ id: seasons.id, seasonNumber: seasons.seasonNumber })
		.from(seasons)
		.where(eq(seasons.seriesId, seriesId))
		.all();
	const seasonIdByNumber = new Map(seasonRows.map((s) => [s.seasonNumber, s.id]));
	const episodeRows = plan.episodes.map((ep) => ({
		...ep,
		seriesId,
		seasonId: seasonIdByNumber.get(ep.seasonNumber ?? Number.NaN) ?? null
	}));
	if (episodeRows.length > 0) {
		tx.insert(episodes).values(episodeRows).onConflictDoNothing().run();
	}
}

/** Convenience wrapper: run {@link persistEpisodePlanIn} in its own transaction. */
export function persistEpisodePlan(
	seriesId: string,
	plan: SeriesEpisodePlan,
	options: { wipe: boolean }
): void {
	db.transaction((tx) => {
		persistEpisodePlanIn(tx, seriesId, plan, options);
	});
}

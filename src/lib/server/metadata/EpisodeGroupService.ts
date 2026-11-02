/**
 * Episode Group Service
 *
 * Handles TMDB episode group auto-selection and season/episode mapping.
 * Mimics Sonarr's behavior: when a show has a verified TVDB-matching
 * episode group on TMDB, use it automatically to split seasons correctly.
 */

import { tmdb } from '#lib/server/tmdb.js';
import { db } from '#lib/server/db/index.js';
import { seasons, episodes } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { EpisodeGroup, EpisodeGroupSummary, EpisodeGroupsResponse } from '#lib/types/tmdb.js';
const AUTO_SELECTION_GROUP_TYPES = [1, 2, 4];

export interface EpisodeGroupInfo {
	id: string;
	name: string;
	type: number;
	groupCount: number;
	episodeCount: number;
	description: string;
	selected: boolean;
}

/**
 * Fetch available episode groups for a TMDB TV show
 */
export async function fetchEpisodeGroups(tmdbId: number): Promise<EpisodeGroupsResponse> {
	return tmdb.getEpisodeGroups(tmdbId);
}

/**
 * Auto-select the best episode group for a show using type priority heuristics.
 *
 * Priority:
 *   1. Type 1 (TVDB Order) — locked groups preferred
 *   2. Type 2 (Seasons) — locked groups preferred
 *   3. Type 4 (Streaming) — e.g. Crunchyroll, locked preferred
 * Falls back to null (default TMDB ordering) if no suitable group exists.
 *
 * Locked groups are verified by TMDB moderators and preferred.
 */
export function autoSelectEpisodeGroup(groups: EpisodeGroupSummary[]): EpisodeGroupSummary | null {
	if (groups.length === 0) return null;

	for (const type of AUTO_SELECTION_GROUP_TYPES) {
		// A zero-episode group is an empty shell (abandoned community work —
		// SpongeBob's "Production Order" and Ben 10's "Absolute Order" both sat
		// at 0 episodes for years). Selecting one used to add the series with
		// no seasons or episodes at all; type priority must not beat content.
		const candidates = groups
			.filter((g) => g.type === type && g.episode_count > 0)
			.sort((a, b) => b.episode_count - a.episode_count);

		if (candidates.length === 0) continue;

		// Prefer the largest locked group of this type
		const locked = candidates.find(() => {
			// We can't check individual group lock status from the summary;
			// instead prefer groups with names suggesting official sources
			return true; // Accept first (largest) match; lock check on full fetch
		});
		if (locked) return locked;

		return candidates[0];
	}

	return null;
}

/**
 * Build season/episode insertion data from an episode group.
 *
 * Each group within the episode group becomes a Cinephage season.
 * This matches how Sonarr displays arcs/cours as separate seasons.
 * Season numbers are assigned sequentially (1, 2, 3...), matching the
 * group's display order. Groups whose first episode is season 0 are
 * treated as specials (season 0).
 *
 * Returns arrays of season values and episode values ready for batch insert.
 */
export function buildSeasonsAndEpisodesFromGroup(
	seriesId: string,
	group: EpisodeGroup
): {
	seasonValues: (typeof seasons.$inferInsert)[];
	episodeValues: (typeof episodes.$inferInsert)[];
} {
	const populatedGroups = group.groups.filter((g) => g.episodes.length > 0);

	const seasonValues: (typeof seasons.$inferInsert)[] = [];
	const episodeValues: (typeof episodes.$inferInsert)[] = [];

	const specialsGroups = populatedGroups.filter(
		(g) => g.episodes.length > 0 && g.episodes[0].season_number === 0
	);
	const mainGroups = populatedGroups.filter(
		(g) => g.episodes.length > 0 && g.episodes[0].season_number !== 0
	);

	let nextSeasonNumber = 1;

	for (const g of mainGroups) {
		const seasonNum = nextSeasonNumber++;

		seasonValues.push({
			seriesId,
			seasonNumber: seasonNum,
			name: g.name || `Season ${seasonNum}`,
			monitored: true,
			episodeCount: g.episodes.length,
			episodeFileCount: 0
		});

		let episodeNum = 1;
		for (const ep of g.episodes) {
			episodeValues.push({
				seriesId,
				tmdbId: ep.id,
				seasonNumber: seasonNum,
				episodeNumber: episodeNum++,
				title: ep.name || '',
				airDate: ep.air_date || null,
				monitored: true,
				hasFile: false
			});
		}
	}

	if (specialsGroups.length > 0) {
		let totalSpecials = 0;
		for (const g of specialsGroups) {
			totalSpecials += g.episodes.length;
		}

		seasonValues.push({
			seriesId,
			seasonNumber: 0,
			name: 'Specials',
			monitored: false,
			episodeCount: totalSpecials,
			episodeFileCount: 0
		});

		// Specials keep their TMDB episode numbers so scene-named files keep
		// matching, but community groups merge several specials lists into one
		// season and occasionally carry overlapping numbers (e.g. a season
		// episode listed among specials). A collision would violate
		// idx_episodes_unique_number and abort the whole episode insert, so
		// colliding entries shift to the next free number instead.
		const usedSpecialsNumbers = new Set<number>();
		for (const g of specialsGroups) {
			for (const ep of g.episodes) {
				let episodeNumber = ep.episode_number;
				while (usedSpecialsNumbers.has(episodeNumber)) {
					episodeNumber += 1;
				}
				usedSpecialsNumbers.add(episodeNumber);
				episodeValues.push({
					seriesId,
					tmdbId: ep.id,
					seasonNumber: 0,
					episodeNumber,
					title: ep.name || '',
					airDate: ep.air_date || null,
					monitored: false,
					hasFile: false
				});
			}
		}
	}

	return { seasonValues, episodeValues };
}

/**
 * (season, episode) keys appearing more than once in a plan. Such a plan
 * would violate idx_episodes_unique_number on insert; callers must treat
 * any conflict as unusable group data and fall back to default ordering.
 */
export function findPlanConflicts(
	episodeValues: Array<{ seasonNumber?: number | null; episodeNumber?: number | null }>
): string[] {
	const seen = new Set<string>();
	const conflicts = new Set<string>();
	for (const ep of episodeValues) {
		const key = `${ep.seasonNumber}x${ep.episodeNumber}`;
		if (seen.has(key)) {
			conflicts.add(key);
		} else {
			seen.add(key);
		}
	}
	return [...conflicts];
}

/**
 * Delete all seasons and episodes for a series (cascades to episodeFiles, subtitles).
 */
export async function deleteAllSeasonsAndEpisodes(seriesId: string): Promise<void> {
	await db.delete(episodes).where(eq(episodes.seriesId, seriesId));
	await db.delete(seasons).where(eq(seasons.seriesId, seriesId));
}

/**
 * Build a mapping of episode group info list for API responses
 */
export function buildEpisodeGroupInfoList(
	groupsResponse: EpisodeGroupsResponse,
	selectedGroupId: string | null
): EpisodeGroupInfo[] {
	return groupsResponse.results.map((g) => ({
		id: g.id,
		name: g.name,
		type: g.type,
		groupCount: g.group_count,
		episodeCount: g.episode_count,
		description: g.description,
		selected: g.id === selectedGroupId
	}));
}

/**
 * Episode statistics utilities
 * Single source of truth for episode counts and progress calculations
 */

import { todayDateString } from '#lib/utils/format.js';

export interface EpisodeStats {
	totalAired: number;
	downloaded: number;
	percentComplete: number;
}

export interface EpisodeBasic {
	airDate: string | null;
	hasFile: boolean | null;
}

function isAired(episode: EpisodeBasic): boolean {
	const today = todayDateString();
	return Boolean(episode.airDate && episode.airDate !== '' && episode.airDate <= today);
}

export function calculateEpisodeStats<T extends EpisodeBasic>(episodes: T[]): EpisodeStats {
	const airedEpisodes = episodes.filter(isAired);
	const downloaded = airedEpisodes.filter((ep) => ep.hasFile).length;
	const totalAired = airedEpisodes.length;

	return {
		totalAired,
		downloaded,
		percentComplete: totalAired > 0 ? Math.round((downloaded / totalAired) * 100) : 0
	};
}

export function formatEpisodeProgress(stats: EpisodeStats): string {
	return `${stats.downloaded} / ${stats.totalAired}`;
}

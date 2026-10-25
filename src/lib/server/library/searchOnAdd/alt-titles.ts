/**
 * Alternate title refresh helpers — shared caching logic for searchOnAdd
 */

import {
	getMovieSearchTitles,
	getSeriesSearchTitles,
	fetchAndStoreMovieAlternateTitles,
	fetchAndStoreSeriesAlternateTitles
} from '#lib/server/services/AlternateTitleService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'AltTitlesSearch', logDomain: 'scans' });

export const ALT_TITLE_REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
export const ALT_TITLE_REFRESH_CACHE_MAX_ENTRIES = 2000;

export class AltTitleRefresher {
	private readonly movieAltTitleRefreshAttempts = new Map<string, number>();
	private readonly seriesAltTitleRefreshAttempts = new Map<string, number>();

	shouldExposeOperationalError(error: string | undefined): boolean {
		if (!error) return false;
		const normalized = error.trim().toLowerCase();
		if (!normalized) return false;
		return !(
			normalized.includes('no suitable releases found') ||
			normalized.includes('no upgrades found') ||
			normalized.includes('no releases found that')
		);
	}

	private pruneAltTitleRefreshCache(cache: Map<string, number>, now: number): void {
		if (cache.size <= ALT_TITLE_REFRESH_CACHE_MAX_ENTRIES) return;
		for (const [mediaId, attemptedAt] of cache.entries()) {
			if (now - attemptedAt >= ALT_TITLE_REFRESH_COOLDOWN_MS) {
				cache.delete(mediaId);
			}
		}
		if (cache.size <= ALT_TITLE_REFRESH_CACHE_MAX_ENTRIES) return;
		const overflow = cache.size - ALT_TITLE_REFRESH_CACHE_MAX_ENTRIES;
		let removed = 0;
		for (const mediaId of cache.keys()) {
			cache.delete(mediaId);
			removed++;
			if (removed >= overflow) break;
		}
	}

	private shouldAttemptAltTitleRefresh(cache: Map<string, number>, mediaId: string): boolean {
		const now = Date.now();
		const previousAttempt = cache.get(mediaId);
		if (
			typeof previousAttempt === 'number' &&
			now - previousAttempt < ALT_TITLE_REFRESH_COOLDOWN_MS
		) {
			return false;
		}
		cache.set(mediaId, now);
		this.pruneAltTitleRefreshCache(cache, now);
		return true;
	}

	async getMovieSearchTitlesWithRefresh(movieId: string, tmdbId?: number): Promise<string[]> {
		let titles = await getMovieSearchTitles(movieId);
		if (tmdbId && titles.length <= 1) {
			if (this.shouldAttemptAltTitleRefresh(this.movieAltTitleRefreshAttempts, movieId)) {
				await fetchAndStoreMovieAlternateTitles(movieId, tmdbId);
				titles = await getMovieSearchTitles(movieId);
			} else {
				logger.debug(
					{ movieId, tmdbId },
					'[SearchOnAdd] Skipping movie alternate title refresh during cooldown'
				);
			}
		}
		return titles;
	}

	async getSeriesSearchTitlesWithRefresh(seriesId: string, tmdbId?: number): Promise<string[]> {
		let titles = await getSeriesSearchTitles(seriesId);
		if (tmdbId && titles.length <= 1) {
			if (this.shouldAttemptAltTitleRefresh(this.seriesAltTitleRefreshAttempts, seriesId)) {
				await fetchAndStoreSeriesAlternateTitles(seriesId, tmdbId);
				titles = await getSeriesSearchTitles(seriesId);
			} else {
				logger.debug(
					{ seriesId, tmdbId },
					'[SearchOnAdd] Skipping series alternate title refresh during cooldown'
				);
			}
		}
		return titles;
	}

	/** Test-only helper to reset in-memory refresh guards between test cases. */
	resetAlternateTitleRefreshAttemptCacheForTests(): void {
		if (process.env.NODE_ENV !== 'test') return;
		this.movieAltTitleRefreshAttempts.clear();
		this.seriesAltTitleRefreshAttempts.clear();
	}
}

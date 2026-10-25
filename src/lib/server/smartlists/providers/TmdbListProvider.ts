/**
 * TMDb List Provider
 *
 * Fetches movies from a specific TMDb list by ID
 * Uses the TMDb /list/{list_id} endpoint
 */
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'monitoring' as const });
import { tmdb } from '#lib/server/tmdb.js';
import type { ExternalListProvider, ExternalListItem, ExternalListResult } from './types.js';

export interface TmdbListConfig {
	/** TMDb list ID */
	listId: string;
}

interface TmdbListItem {
	id: number;
	media_type: 'movie' | 'tv';
	title?: string; // For movies
	name?: string; // For TV shows
	original_title?: string;
	original_name?: string;
	overview: string;
	poster_path: string | null;
	backdrop_path: string | null;
	release_date?: string; // For movies
	first_air_date?: string; // For TV shows
	vote_average: number;
	vote_count: number;
	popularity: number;
	genre_ids: number[];
	original_language: string;
	adult: boolean;
}

interface TmdbListResponse {
	id: number;
	name: string;
	description: string;
	poster_path: string | null;
	item_count: number;
	page: number;
	total_pages: number;
	total_results: number;
	items: TmdbListItem[];
}

export class TmdbListProvider implements ExternalListProvider {
	readonly type = 'tmdb-list';
	readonly name = 'TMDb List';

	private normalizeListId(listId: string): string | null {
		const trimmed = listId.trim();
		if (!trimmed) return null;

		// Already a plain list ID
		if (/^\d+$/.test(trimmed)) {
			return trimmed;
		}

		// Slug format from some links, e.g. "12345-my-list"
		const slugMatch = trimmed.match(/^(\d+)-/);
		if (slugMatch) {
			return slugMatch[1];
		}

		// Full URL format, e.g. https://www.themoviedb.org/list/12345-my-list
		const urlMatch = trimmed.match(/\/list\/(\d+)/);
		if (urlMatch) {
			return urlMatch[1];
		}

		return null;
	}

	validateConfig(config: unknown): boolean {
		if (typeof config !== 'object' || config === null) {
			return false;
		}
		const cfg = config as Partial<TmdbListConfig>;
		return typeof cfg.listId === 'string' && this.normalizeListId(cfg.listId) !== null;
	}

	async fetchItems(config: unknown, mediaType: 'movie' | 'tv' | ''): Promise<ExternalListResult> {
		const cfg = config as TmdbListConfig;
		const items: ExternalListItem[] = [];
		const normalizedListId = this.normalizeListId(cfg.listId);
		if (!normalizedListId) {
			return {
				items,
				totalCount: 0,
				failedCount: 0,
				error: 'Invalid TMDb list ID format'
			};
		}

		logger.info(
			{
				listId: normalizedListId,
				mediaType
			},
			'[TmdbListProvider] Starting TMDb list fetch'
		);

		try {
			let currentPage = 1;
			let totalPages = 1;

			while (currentPage <= totalPages) {
				const response = (await tmdb.fetch(
					`/list/${normalizedListId}?page=${currentPage}`,
					{},
					true
				)) as TmdbListResponse;

				if (currentPage === 1) {
					if (!response.items || response.items.length === 0) {
						logger.info({ listId: normalizedListId }, '[TmdbListProvider] List is empty');
						return { items: [], totalCount: 0, failedCount: 0 };
					}
					totalPages = response.total_pages ?? 1;
					logger.info(
						{
							listId: normalizedListId,
							listName: response.name,
							totalResults: response.total_results,
							totalPages
						},
						'[TmdbListProvider] Fetched list metadata'
					);
				}

				for (const item of response.items ?? []) {
					if (mediaType && item.media_type && item.media_type !== mediaType) {
						continue;
					}
					const parsedItem = this.parseItem(item);
					if (parsedItem) {
						items.push(parsedItem);
					}
				}

				currentPage++;
			}

			logger.info(
				{
					listId: normalizedListId,
					totalItems: items.length,
					pagesFetched: currentPage - 1,
					totalPages
				},
				'[TmdbListProvider] Completed TMDb list fetch'
			);

			return {
				items,
				totalCount: items.length,
				failedCount: 0
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(
				{
					error: errorMessage,
					listId: normalizedListId
				},
				'[TmdbListProvider] Failed to fetch TMDb list'
			);

			return {
				items,
				totalCount: items.length,
				failedCount: 0,
				error: errorMessage
			};
		}
	}

	private parseItem(item: TmdbListItem): ExternalListItem | null {
		// Extract year from release_date or first_air_date
		let year: number | undefined;
		const dateField = item.release_date || item.first_air_date;
		if (dateField) {
			const yearMatch = dateField.match(/^(\d{4})/);
			if (yearMatch) {
				year = parseInt(yearMatch[1], 10);
			}
		}

		// Use title for movies, name for TV shows
		const title = item.title || item.name;
		if (!title) {
			logger.debug({ id: item.id }, '[TmdbListProvider] Item missing title');
			return null;
		}

		return {
			tmdbId: item.id,
			title,
			year,
			overview: item.overview,
			posterPath: item.poster_path,
			voteAverage: item.vote_average,
			voteCount: item.vote_count,
			genreIds: item.genre_ids,
			originalLanguage: item.original_language
		};
	}
}

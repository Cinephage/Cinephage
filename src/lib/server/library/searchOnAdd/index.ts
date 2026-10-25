/**
 * Search On Add Service
 *
 * Handles automatic searching and grabbing when media is added to the library.
 * Split into per-media-type modules for maintainability.
 */

import { AltTitleRefresher } from './alt-titles.js';
import { searchForMovie } from './search-movie.js';
import { searchForSeries } from './search-series.js';
import { searchForEpisode } from './search-episode.js';
import { searchForSeason } from './search-season.js';
import { searchForMissingEpisodes } from './search-missing.js';
import { searchBulkEpisodes } from './search-bulk.js';
import type {
	GrabResult,
	AutoSearchItemResult,
	MultiSearchResult,
	SearchForMovieParams,
	SearchForSeriesParams,
	SearchForEpisodeParams,
	SearchForSeasonParams,
	SearchForMissingEpisodesOptions
} from './types.js';
import type { SearchProgressUpdate } from '#lib/server/downloads/MultiSeasonSearchStrategy.js';

export type {
	GrabResult,
	AutoSearchItemResult,
	MultiSearchResult,
	SearchForMovieParams,
	SearchForSeriesParams,
	SearchForEpisodeParams,
	SearchForSeasonParams,
	SearchForMissingEpisodesOptions
};

class SearchOnAddService {
	private readonly altTitles = new AltTitleRefresher();

	async searchForMovie(params: SearchForMovieParams): Promise<GrabResult> {
		return searchForMovie(params, this.altTitles);
	}

	async searchForSeries(params: SearchForSeriesParams): Promise<GrabResult> {
		return searchForSeries(params, this.altTitles);
	}

	async searchForEpisode(params: SearchForEpisodeParams): Promise<GrabResult> {
		return searchForEpisode(params, this.altTitles);
	}

	async searchForSeason(params: SearchForSeasonParams): Promise<GrabResult> {
		return searchForSeason(params, this.altTitles);
	}

	async searchForMissingEpisodes(
		seriesId: string,
		onProgress?: (update: SearchProgressUpdate) => void,
		options?: SearchForMissingEpisodesOptions
	): Promise<MultiSearchResult> {
		return searchForMissingEpisodes(
			seriesId,
			onProgress,
			options ?? {},
			this.altTitles,
			this.searchForEpisode.bind(this) as typeof searchForEpisode,
			this.searchForSeason.bind(this) as typeof searchForSeason
		);
	}

	async searchBulkEpisodes(
		episodeIds: string[],
		onProgress?: (update: SearchProgressUpdate) => void
	): Promise<MultiSearchResult> {
		return searchBulkEpisodes(episodeIds, onProgress, this.altTitles);
	}

	resetAlternateTitleRefreshAttemptCacheForTests(): void {
		this.altTitles.resetAlternateTitleRefreshAttemptCacheForTests();
	}
}

export const searchOnAdd = new SearchOnAddService();

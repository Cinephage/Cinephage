import { EventEmitter } from 'events';

export interface MovieUpdatedEvent {
	movieId: string;
}

export interface SeriesUpdatedEvent {
	seriesId: string;
}

export interface LibraryDataChangedEvent {
	/** Which source category was mutated */
	source: 'movie' | 'series' | 'episode' | 'season' | 'root-folder' | 'library';
	/** Free-form reason for logging/telemetry */
	reason: string;
	/** Optional affected entity id */
	entityId?: string;
	/**
	 * TMDB id of the affected media when known. Consumers that match by
	 * TMDB identity (e.g. pending request projection) use this instead of
	 * re-resolving entityId -> tmdbId per event.
	 */
	tmdbId?: number;
}

export interface SeriesSearchStartedEvent {
	seriesId: string;
	searchType: 'episode' | 'season' | 'missing' | 'bulk';
	seasonNumber?: number;
}

export interface SeriesSearchCompletedEvent {
	seriesId: string;
	searchType: 'episode' | 'season' | 'missing' | 'bulk';
	seasonNumber?: number;
}

export interface MovieSearchStartedEvent {
	movieId: string;
}

export interface MovieSearchCompletedEvent {
	movieId: string;
}

// ============================================================================
// Search Progress Events
// ============================================================================

export type SearchPhase =
	| 'initializing'
	| 'searching'
	| 'evaluating'
	| 'grabbing'
	| 'complete_series_search'
	| 'multi_season_search'
	| 'single_season_search'
	| 'individual_episode_search'
	| 'complete'
	| 'error';

export type ReleasePackType = 'complete_series' | 'multi_season' | 'single_season' | 'episode';

export interface SearchProgressDetails {
	/** Name of the indexer being queried */
	indexerName?: string;
	/** Name of the release being evaluated */
	releaseName?: string;
	/** Type of pack being evaluated */
	releaseType?: ReleasePackType;
	/** Seasons covered by the release */
	seasons?: number[];
	/** Episode count covered */
	episodeCount?: number;
	/** Score of the release */
	score?: number;
	/** Decision for this release */
	decision?: 'accepted' | 'rejected' | 'pending';
	/** Reason for rejection */
	rejectionReason?: string;
	/** Coverage statistics for packs */
	coverageStats?: {
		totalMissing: number;
		wouldCover: number;
		wouldUpgrade: number;
		wouldDowngrade: number;
	};
}

export interface SearchProgressEvent {
	/** Unique search ID */
	searchId: string;
	/** Series ID if applicable */
	seriesId?: string;
	/** Movie ID if applicable */
	movieId?: string;
	/** Current phase of the search */
	phase: SearchPhase;
	/** Human-readable message */
	message: string;
	/** Progress information */
	progress?: {
		current: number;
		total: number;
	};
	/** Detailed information about the current operation */
	details?: SearchProgressDetails;
}

export interface PackGrabbedResult {
	/** Type of pack */
	type: ReleasePackType;
	/** Seasons covered */
	seasons: number[];
	/** Release name */
	releaseName: string;
	/** Number of episodes covered */
	episodesCovered: number;
	/** Whether this is an upgrade */
	isUpgrade?: boolean;
}

export interface EpisodeGrabbedResult {
	/** Episode ID */
	episodeId: string;
	/** Episode label (S01E05) */
	label: string;
	/** Release name */
	releaseName: string;
	/** Whether grabbed via a pack */
	wasPackGrab?: boolean;
	/** Pack season if applicable */
	packSeason?: number;
}

export interface SearchCompletedEvent {
	/** Unique search ID */
	searchId: string;
	/** Series ID if applicable */
	seriesId?: string;
	/** Movie ID if applicable */
	movieId?: string;
	/** Whether search was successful */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Search results */
	results: {
		/** Total items searched */
		totalSearched: number;
		/** Total releases found */
		totalFound: number;
		/** Total items grabbed */
		totalGrabbed: number;
		/** Complete series packs grabbed */
		completeSeriesPacksGrabbed: number;
		/** Multi-season packs grabbed */
		multiSeasonPacksGrabbed: number;
		/** Single season packs grabbed */
		singleSeasonPacksGrabbed: number;
		/** Individual episodes grabbed (not via pack) */
		individualEpisodesGrabbed: number;
		/** Detailed pack results */
		packsGrabbed: PackGrabbedResult[];
		/** Detailed episode results */
		episodesGrabbed: EpisodeGrabbedResult[];
		/** Episodes not found */
		notFound: string[];
		/** Errors encountered */
		errors: string[];
	};
}

type LibraryMediaEventMap = {
	'movie:updated': (event: MovieUpdatedEvent) => void;
	'series:updated': (event: SeriesUpdatedEvent) => void;
	'series:searchStarted': (event: SeriesSearchStartedEvent) => void;
	'series:searchCompleted': (event: SeriesSearchCompletedEvent) => void;
	'movie:searchStarted': (event: MovieSearchStartedEvent) => void;
	'movie:searchCompleted': (event: MovieSearchCompletedEvent) => void;
	'search:progress': (event: SearchProgressEvent) => void;
	'search:completed': (event: SearchCompletedEvent) => void;
	'library:data-changed': (event: LibraryDataChangedEvent) => void;
};

class LibraryMediaEvents extends EventEmitter {
	emitMovieUpdated(movieId: string): void {
		this.emit('movie:updated', { movieId });
		// Fan-out: any movie mutation also signals a generic library data change
		// so downstream subscribers (e.g. ReconciliationService) refresh without
		// needing to know about per-entity events.
		this.emit('library:data-changed', {
			source: 'movie' as const,
			reason: 'movie-updated',
			entityId: movieId
		});
	}

	emitSeriesUpdated(seriesId: string): void {
		this.emit('series:updated', { seriesId });
		// Fan-out: see emitMovieUpdated for rationale.
		this.emit('library:data-changed', {
			source: 'series' as const,
			reason: 'series-updated',
			entityId: seriesId
		});
	}

	emitLibraryDataChanged(event: LibraryDataChangedEvent): void {
		this.emit('library:data-changed', event);
	}

	emitSeriesSearchStarted(event: SeriesSearchStartedEvent): void {
		this.emit('series:searchStarted', event);
	}

	emitSeriesSearchCompleted(event: SeriesSearchCompletedEvent): void {
		this.emit('series:searchCompleted', event);
	}

	emitMovieSearchStarted(event: MovieSearchStartedEvent): void {
		this.emit('movie:searchStarted', event);
	}

	emitMovieSearchCompleted(event: MovieSearchCompletedEvent): void {
		this.emit('movie:searchCompleted', event);
	}

	onMovieUpdated(handler: LibraryMediaEventMap['movie:updated']): void {
		this.on('movie:updated', handler);
	}

	offMovieUpdated(handler: LibraryMediaEventMap['movie:updated']): void {
		this.off('movie:updated', handler);
	}

	onSeriesUpdated(handler: LibraryMediaEventMap['series:updated']): void {
		this.on('series:updated', handler);
	}

	offSeriesUpdated(handler: LibraryMediaEventMap['series:updated']): void {
		this.off('series:updated', handler);
	}

	onSeriesSearchStarted(handler: LibraryMediaEventMap['series:searchStarted']): void {
		this.on('series:searchStarted', handler);
	}

	offSeriesSearchStarted(handler: LibraryMediaEventMap['series:searchStarted']): void {
		this.off('series:searchStarted', handler);
	}

	onSeriesSearchCompleted(handler: LibraryMediaEventMap['series:searchCompleted']): void {
		this.on('series:searchCompleted', handler);
	}

	offSeriesSearchCompleted(handler: LibraryMediaEventMap['series:searchCompleted']): void {
		this.off('series:searchCompleted', handler);
	}

	onMovieSearchStarted(handler: LibraryMediaEventMap['movie:searchStarted']): void {
		this.on('movie:searchStarted', handler);
	}

	offMovieSearchStarted(handler: LibraryMediaEventMap['movie:searchStarted']): void {
		this.off('movie:searchStarted', handler);
	}

	onMovieSearchCompleted(handler: LibraryMediaEventMap['movie:searchCompleted']): void {
		this.on('movie:searchCompleted', handler);
	}

	offMovieSearchCompleted(handler: LibraryMediaEventMap['movie:searchCompleted']): void {
		this.off('movie:searchCompleted', handler);
	}

	onSearchProgress(handler: LibraryMediaEventMap['search:progress']): void {
		this.on('search:progress', handler);
	}

	offSearchProgress(handler: LibraryMediaEventMap['search:progress']): void {
		this.off('search:progress', handler);
	}

	onSearchCompleted(handler: LibraryMediaEventMap['search:completed']): void {
		this.on('search:completed', handler);
	}

	offSearchCompleted(handler: LibraryMediaEventMap['search:completed']): void {
		this.off('search:completed', handler);
	}

	onLibraryDataChanged(handler: LibraryMediaEventMap['library:data-changed']): void {
		this.on('library:data-changed', handler);
	}

	offLibraryDataChanged(handler: LibraryMediaEventMap['library:data-changed']): void {
		this.off('library:data-changed', handler);
	}

	// ============================================================================
	// Event Emitter Methods
	// ============================================================================

	emitSearchProgress(event: SearchProgressEvent): void {
		this.emit('search:progress', event);
	}

	emitSearchCompleted(event: SearchCompletedEvent): void {
		this.emit('search:completed', event);
	}
}

export const libraryMediaEvents = new LibraryMediaEvents();

import { randomUUID } from 'node:crypto';

const FIXED_DATE = '2024-01-01T00:00:00.000Z';

export interface MovieFixture {
	id: string;
	tmdbId: number;
	imdbId: string | null;
	title: string;
	originalTitle: string | null;
	year: number | null;
	overview: string | null;
	posterPath: string | null;
	backdropPath: string | null;
	runtime: number | null;
	genres: string[];
	metadataProvider: string;
	providerRefs: Record<string, string>;
	pinnedExternal: unknown;
	path: string;
	libraryId: string | null;
	rootFolderId: string | null;
	scoringProfileId: string | null;
	languageProfileId: string | null;
	monitored: boolean;
	minimumAvailability: string;
	added: string;
	hasFile: boolean;
	wantsSubtitles: boolean;
	lastSearchTime: string | null;
	consecutiveFailureCount: number;
	autoSearchPaused: boolean;
	tmdbCollectionId: number | null;
	collectionName: string | null;
	releaseDate: string | null;
	downloadReleaseDate: string | null;
	downloadReleaseType: string | null;
	digitalReleaseDate: string | null;
	physicalReleaseDate: string | null;
	availabilityDelay: number;
}

export function createMovie(overrides?: Partial<MovieFixture>): MovieFixture {
	return {
		id: randomUUID(),
		tmdbId: 12345,
		imdbId: null,
		title: 'Test Movie',
		originalTitle: null,
		year: 2024,
		overview: null,
		posterPath: null,
		backdropPath: null,
		runtime: null,
		genres: [],
		metadataProvider: 'auto',
		providerRefs: {},
		pinnedExternal: null,
		path: '/movies/Test Movie (2024)',
		libraryId: null,
		rootFolderId: null,
		scoringProfileId: null,
		languageProfileId: null,
		monitored: true,
		minimumAvailability: 'released',
		added: FIXED_DATE,
		hasFile: false,
		wantsSubtitles: true,
		lastSearchTime: null,
		consecutiveFailureCount: 0,
		autoSearchPaused: false,
		tmdbCollectionId: null,
		collectionName: null,
		releaseDate: null,
		downloadReleaseDate: null,
		downloadReleaseType: null,
		digitalReleaseDate: null,
		physicalReleaseDate: null,
		availabilityDelay: 0,
		...overrides
	};
}

export interface SeriesFixture {
	id: string;
	tmdbId: number;
	tvdbId: number | null;
	imdbId: string | null;
	title: string;
	originalTitle: string | null;
	year: number | null;
	overview: string | null;
	posterPath: string | null;
	backdropPath: string | null;
	status: string | null;
	network: string | null;
	genres: string[];
	metadataProvider: string;
	providerRefs: Record<string, string>;
	pinnedExternal: unknown;
	path: string;
	libraryId: string | null;
	rootFolderId: string | null;
	scoringProfileId: string | null;
	languageProfileId: string | null;
	monitored: boolean;
	monitorNewItems: string;
	monitorSpecials: boolean;
	seasonFolder: boolean;
	seriesType: string;
	added: string;
	episodeCount: number;
	episodeFileCount: number;
	wantsSubtitles: boolean;
	firstAirDate: string | null;
}

export function createSeries(overrides?: Partial<SeriesFixture>): SeriesFixture {
	return {
		id: randomUUID(),
		tmdbId: 67890,
		tvdbId: null,
		imdbId: null,
		title: 'Test Series',
		originalTitle: null,
		year: 2024,
		overview: null,
		posterPath: null,
		backdropPath: null,
		status: null,
		network: null,
		genres: [],
		metadataProvider: 'auto',
		providerRefs: {},
		pinnedExternal: null,
		path: '/tv/Test Series',
		libraryId: null,
		rootFolderId: null,
		scoringProfileId: null,
		languageProfileId: null,
		monitored: true,
		monitorNewItems: 'all',
		monitorSpecials: false,
		seasonFolder: true,
		seriesType: 'standard',
		added: FIXED_DATE,
		episodeCount: 0,
		episodeFileCount: 0,
		wantsSubtitles: true,
		firstAirDate: null,
		...overrides
	};
}

export interface EpisodeFixture {
	id: string;
	seriesId: string;
	seasonId: string | null;
	tmdbId: number | null;
	tvdbId: number | null;
	seasonNumber: number;
	episodeNumber: number;
	absoluteEpisodeNumber: number | null;
	title: string | null;
	overview: string | null;
	airDate: string | null;
	runtime: number | null;
	monitored: boolean;
	hasFile: boolean;
	wantsSubtitlesOverride: boolean | null;
	lastSearchTime: string | null;
	consecutiveFailureCount: number;
	autoSearchPaused: boolean;
}

export function createEpisode(overrides?: Partial<EpisodeFixture>): EpisodeFixture {
	return {
		id: randomUUID(),
		seriesId: randomUUID(),
		seasonId: null,
		tmdbId: null,
		tvdbId: null,
		seasonNumber: 1,
		episodeNumber: 1,
		absoluteEpisodeNumber: null,
		title: null,
		overview: null,
		airDate: null,
		runtime: null,
		monitored: true,
		hasFile: false,
		wantsSubtitlesOverride: null,
		lastSearchTime: null,
		consecutiveFailureCount: 0,
		autoSearchPaused: false,
		...overrides
	};
}

export interface EpisodeFileFixture {
	id: string;
	seriesId: string;
	seasonNumber: number;
	episodeIds: string[];
	relativePath: string;
	size: number | null;
	dateAdded: string;
	sceneName: string | null;
	releaseGroup: string | null;
	edition: string | null;
	releaseType: string | null;
	quality: unknown;
	mediaInfo: unknown;
	languages: unknown | null;
	infoHash: string | null;
	lastSeenScanId: string | null;
}

export function createEpisodeFile(overrides?: Partial<EpisodeFileFixture>): EpisodeFileFixture {
	return {
		id: randomUUID(),
		seriesId: 'series-1',
		seasonNumber: 1,
		episodeIds: [],
		relativePath: 'Test.Series.S01E01.1080p.mkv',
		size: null,
		dateAdded: FIXED_DATE,
		sceneName: null,
		releaseGroup: null,
		edition: null,
		releaseType: null,
		quality: null,
		mediaInfo: null,
		languages: null,
		infoHash: null,
		lastSeenScanId: null,
		...overrides
	};
}

export interface MovieFileFixture {
	id: string;
	movieId: string;
	relativePath: string;
	size: number | null;
	dateAdded: string;
	sceneName: string | null;
	releaseGroup: string | null;
	quality: unknown;
	mediaInfo: unknown;
	edition: string | null;
	languages: unknown | null;
	infoHash: string | null;
	lastSeenScanId: string | null;
}

export function createMovieFile(overrides?: Partial<MovieFileFixture>): MovieFileFixture {
	return {
		id: randomUUID(),
		movieId: 'movie-1',
		relativePath: 'Test.Movie.2024.1080p.mkv',
		size: null,
		dateAdded: FIXED_DATE,
		sceneName: null,
		releaseGroup: null,
		quality: null,
		mediaInfo: null,
		edition: null,
		languages: null,
		infoHash: null,
		lastSeenScanId: null,
		...overrides
	};
}

export interface MovieTargetFixture {
	type: 'movie';
	movieId: string;
}

export function createMovieTarget(overrides?: Partial<MovieTargetFixture>): MovieTargetFixture {
	return {
		type: 'movie',
		movieId: 'movie-1',
		...overrides
	};
}

export interface EpisodeTargetFixture {
	type: 'episode';
	episodeId: string;
	seriesId: string;
}

export function createEpisodeTarget(
	overrides?: Partial<EpisodeTargetFixture>
): EpisodeTargetFixture {
	return {
		type: 'episode',
		episodeId: 'ep-1',
		seriesId: 'series-1',
		...overrides
	};
}

export interface SeasonTargetFixture {
	type: 'season';
	seriesId: string;
	seasonNumber: number;
	episodeIds: string[];
}

export function createSeasonTarget(overrides?: Partial<SeasonTargetFixture>): SeasonTargetFixture {
	return {
		type: 'season',
		seriesId: 'series-1',
		seasonNumber: 1,
		episodeIds: ['ep-1'],
		...overrides
	};
}

export interface SeriesTargetFixture {
	type: 'series';
	seriesId: string;
	episodeIds: string[];
}

export function createSeriesTarget(overrides?: Partial<SeriesTargetFixture>): SeriesTargetFixture {
	return {
		type: 'series',
		seriesId: 'series-1',
		episodeIds: ['ep-1'],
		...overrides
	};
}

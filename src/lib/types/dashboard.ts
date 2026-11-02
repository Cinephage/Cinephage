export type { UpcomingItem } from '#lib/server/calendar/queries.js';

export interface RecentlyAddedMovie {
	id: string;
	tmdbId: number;
	title: string;
	year: number | null;
	posterPath: string | null;
	hasFile: boolean | null;
	monitored: boolean | null;
	added: string | null;
	availability?: string;
	isReleased?: boolean;
}

export interface RecentlyAddedSeries {
	id: string;
	tmdbId: number;
	title: string;
	year: number | null;
	posterPath: string | null;
	episodeFileCount: number;
	episodeCount: number;
	airedMissingCount: number;
	added: string | null;
}

export interface MissingEpisode {
	id: string;
	seriesId: string;
	seasonNumber: number;
	episodeNumber: number;
	title: string | null;
	airDate: string | null;
	series?: {
		id: string;
		title: string;
		posterPath: string | null;
	} | null;
}

export interface RecentlyAddedData {
	movies: RecentlyAddedMovie[];
	series: RecentlyAddedSeries[];
}

export interface DashboardConfig {
	indexerCount: number;
	downloadClientCount: number;
	rootFolderCount: number;
	tmdbConfigured: boolean;
}

export interface DashboardStats {
	movies: {
		total: number;
		withFile: number;
		missing: number;
		inCinemas: number;
		unreleased: number;
		unmonitoredMissing: number;
		monitored: number;
	};
	series: {
		total: number;
		monitored: number;
	};
	episodes: {
		total: number;
		withFile: number;
		missing: number;
		unaired: number;
		unmonitoredMissing: number;
		monitored: number;
	};
	activeDownloads: number;
	queuedDownloads: number;
	stalledDownloads: number;
	pausedDownloads: number;
	downloadSpeedBytes: number;
	downloadAvgProgress: number;
	movingDownloads: number;
	completedDownloadsLast24h: number;
	unmatchedFiles: number;
	missingRootFolders: number;
	storage: {
		movieBytes: number;
		tvBytes: number;
		totalBytes: number;
		freeBytes: number;
	};
	config: DashboardConfig;
}

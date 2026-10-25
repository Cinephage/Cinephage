import type { MediaBrowserServerType } from '#lib/server/notifications/mediabrowser/types.js';

export interface MediaServerStatsProviderConfig {
	host: string;
	apiKey: string;
	serverId: string;
	serverType: MediaBrowserServerType;
}

export interface SyncedMediaItem {
	serverItemId: string;
	tmdbId: number | null;
	tvdbId: number | null;
	imdbId: string | null;
	title: string;
	year: number | null;
	itemType: 'movie' | 'episode' | 'series' | 'season';
	seriesName: string | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	playCount: number;
	lastPlayedDate: string | null;
	playedPercentage: number | null;
	isPlayed: boolean;
	videoCodec: string | null;
	videoProfile: string | null;
	videoBitDepth: number | null;
	width: number | null;
	height: number | null;
	isHDR: boolean;
	hdrFormat: string | null;
	videoBitrate: number | null;
	audioCodec: string | null;
	audioChannels: number | null;
	audioChannelLayout: string | null;
	audioBitrate: number | null;
	audioLanguages: string[];
	subtitleLanguages: string[];
	/** Untouched source language strings as reported by the media server. */
	audioLanguagesRaw: string[];
	subtitleLanguagesRaw: string[];
	containerFormat: string | null;
	fileSize: number | null;
	bitrate: number | null;
	duration: number | null;
}

export interface SyncResult {
	items: SyncedMediaItem[];
	serverItemIds: Set<string>;
	totalOnServer: number;
}

export interface MediaServerStatsProvider {
	fetchAllItems(): Promise<SyncResult>;
}

export interface AggregatedMediaItem {
	tmdbId: number | null;
	tvdbId: number | null;
	imdbId: string | null;
	title: string;
	year: number | null;
	itemType: string;
	totalPlayCount: number;
	lastPlayedDate: string | null;
	serverBreakdown: Array<{
		serverId: string;
		serverName: string;
		serverType: MediaBrowserServerType;
		playCount: number;
		lastPlayedDate: string | null;
		videoCodec: string | null;
		width: number | null;
		height: number | null;
		isHDR: boolean;
		containerFormat: string | null;
	}>;
}

export interface StatsSummary {
	totalPlays: number;
	uniqueItems: number;
	serversSynced: number;
	resolutionBreakdown: Array<{ label: string; count: number }>;
	codecBreakdown: Array<{ label: string; count: number }>;
	hdrBreakdown: Array<{ label: string; count: number }>;
	audioCodecBreakdown: Array<{ label: string; count: number }>;
	containerBreakdown: Array<{ label: string; count: number }>;
	topPlayedItems: AggregatedMediaItem[];
	largestItems: AggregatedMediaItem[];
	totalFileSize: number;
}

export interface ServerSyncStatus {
	serverId: string;
	serverName: string;
	serverType: MediaBrowserServerType;
	itemCount: number;
	lastSyncAt: string | null;
	lastSyncStatus: string | null;
	enabled: boolean;
}

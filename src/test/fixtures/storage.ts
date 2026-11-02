import { randomUUID } from 'node:crypto';
import type { mediaServerSyncedItems, storageItems } from '#lib/server/db/schema.js';

type MediaServerSyncedItemInsert = typeof mediaServerSyncedItems.$inferInsert;
type StorageItemInsert = typeof storageItems.$inferInsert;

export function createMediaServerItem(
	overrides: Partial<MediaServerSyncedItemInsert> = {}
): MediaServerSyncedItemInsert {
	return {
		id: randomUUID(),
		serverId: overrides.serverId ?? 'server-1',
		serverItemId: overrides.serverItemId ?? randomUUID(),
		tmdbId: overrides.tmdbId ?? 100,
		tvdbId: overrides.tvdbId ?? null,
		imdbId: overrides.imdbId ?? null,
		title: overrides.title ?? 'Test Item',
		year: overrides.year ?? 2020,
		itemType: overrides.itemType ?? 'movie',
		seriesName: overrides.seriesName ?? null,
		seasonNumber: overrides.seasonNumber ?? null,
		episodeNumber: overrides.episodeNumber ?? null,
		playCount: overrides.playCount ?? 0,
		lastPlayedDate: overrides.lastPlayedDate ?? null,
		playedPercentage: overrides.playedPercentage ?? null,
		isPlayed: overrides.isPlayed ?? 0,
		videoCodec: overrides.videoCodec ?? null,
		videoProfile: overrides.videoProfile ?? null,
		videoBitDepth: overrides.videoBitDepth ?? null,
		width: overrides.width ?? null,
		height: overrides.height ?? null,
		isHDR: overrides.isHDR ?? 0,
		hdrFormat: overrides.hdrFormat ?? null,
		videoBitrate: overrides.videoBitrate ?? null,
		audioCodec: overrides.audioCodec ?? null,
		audioChannels: overrides.audioChannels ?? null,
		audioChannelLayout: overrides.audioChannelLayout ?? null,
		audioBitrate: overrides.audioBitrate ?? null,
		audioLanguages: overrides.audioLanguages ?? [],
		subtitleLanguages: overrides.subtitleLanguages ?? [],
		containerFormat: overrides.containerFormat ?? null,
		fileSize: overrides.fileSize ?? null,
		bitrate: overrides.bitrate ?? null,
		duration: overrides.duration ?? null,
		lastSyncedAt: overrides.lastSyncedAt ?? new Date().toISOString(),
		createdAt: overrides.createdAt ?? new Date().toISOString(),
		updatedAt: overrides.updatedAt ?? new Date().toISOString(),
		...overrides
	};
}

export function createStorageItem(overrides: Partial<StorageItemInsert> = {}): StorageItemInsert {
	return {
		id: randomUUID(),
		itemType: overrides.itemType ?? 'movie',
		tmdbId: overrides.tmdbId ?? 100,
		tvdbId: overrides.tvdbId ?? null,
		imdbId: overrides.imdbId ?? null,
		title: overrides.title ?? 'Test Item',
		year: overrides.year ?? 2020,
		seriesName: overrides.seriesName ?? null,
		seasonNumber: overrides.seasonNumber ?? null,
		episodeNumber: overrides.episodeNumber ?? null,
		movieFileId: overrides.movieFileId ?? null,
		episodeFileId: overrides.episodeFileId ?? null,
		rootFolderId: overrides.rootFolderId ?? null,
		libraryId: overrides.libraryId ?? null,
		sourceSystem: overrides.sourceSystem ?? 'local',
		matchConfidence: overrides.matchConfidence ?? 'exact',
		firstSeenAt: overrides.firstSeenAt ?? new Date().toISOString(),
		lastReconciledAt: overrides.lastReconciledAt ?? new Date().toISOString(),
		...overrides
	};
}

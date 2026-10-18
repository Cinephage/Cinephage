import type {
	DownloadQueueRecord,
	DownloadHistoryRecord,
	MonitoringHistoryRecord
} from './types.js';
import type { ActivityEvent } from '#lib/types/activity.js';
import { parseRelease } from '#lib/server/indexers/parser/ReleaseParser.js';

export interface MediaInfo {
	id: string;
	title: string;
	year: number | null;
}

export interface SeriesInfo extends MediaInfo {
	seasonNumber?: number;
}

export interface EpisodeInfo {
	id: string;
	seriesId: string;
	episodeNumber: number;
	seasonNumber: number;
}

export interface MediaMaps {
	movies: Map<string, MediaInfo>;
	series: Map<string, SeriesInfo>;
	episodes: Map<string, EpisodeInfo>;
}

export interface ResolvedMediaInfo {
	mediaType: 'movie' | 'episode';
	mediaId: string;
	mediaTitle: string;
	mediaYear: number | null;
	seriesId?: string;
	seriesTitle?: string;
	seasonNumber?: number;
	episodeNumber?: number;
}

export function deriveFallbackMediaInfo(
	releaseTitle: string | null | undefined,
	isEpisode: boolean
): {
	mediaType: 'movie' | 'episode';
	mediaId: string;
	mediaTitle: string;
	mediaYear: number | null;
	seasonNumber?: number;
	episodeNumber?: number;
} {
	if (!releaseTitle) {
		return {
			mediaType: isEpisode ? 'episode' : 'movie',
			mediaId: '',
			mediaTitle: 'Unknown',
			mediaYear: null
		};
	}

	const parsed = parseRelease(releaseTitle);
	const fallbackTitle = releaseTitle.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
	const baseTitle = parsed.cleanTitle?.trim() || fallbackTitle || 'Unknown';

	if (!isEpisode) {
		return {
			mediaType: 'movie',
			mediaId: '',
			mediaTitle: baseTitle,
			mediaYear: parsed.year ?? null
		};
	}

	const seasonNumber = parsed.episode?.season;
	const episodeNumbers = parsed.episode?.episodes;
	const firstEpisode = episodeNumbers?.[0];
	const lastEpisode =
		episodeNumbers && episodeNumbers.length > 0
			? episodeNumbers[episodeNumbers.length - 1]
			: undefined;

	let mediaTitle = baseTitle;
	if (seasonNumber && firstEpisode) {
		const season = String(seasonNumber).padStart(2, '0');
		const startEpisode = String(firstEpisode).padStart(2, '0');
		if (lastEpisode && lastEpisode !== firstEpisode) {
			const endEpisode = String(lastEpisode).padStart(2, '0');
			mediaTitle = `${baseTitle} S${season}E${startEpisode}-E${endEpisode}`;
		} else {
			mediaTitle = `${baseTitle} S${season}E${startEpisode}`;
		}
	} else if (seasonNumber && parsed.episode?.isSeasonPack) {
		mediaTitle = `${baseTitle} Season ${seasonNumber}`;
	}

	return {
		mediaType: 'episode',
		mediaId: '',
		mediaTitle,
		mediaYear: parsed.year ?? null,
		seasonNumber: seasonNumber ?? undefined,
		episodeNumber: firstEpisode ?? undefined
	};
}

export function resolveMediaInfo(
	item: DownloadQueueRecord | DownloadHistoryRecord,
	mediaMaps: MediaMaps
): ResolvedMediaInfo {
	if (item.movieId && mediaMaps.movies.has(item.movieId)) {
		const movie = mediaMaps.movies.get(item.movieId)!;
		return {
			mediaType: 'movie',
			mediaId: movie.id,
			mediaTitle: movie.title,
			mediaYear: movie.year
		};
	}

	if (item.seriesId && mediaMaps.series.has(item.seriesId)) {
		const s = mediaMaps.series.get(item.seriesId)!;
		const seasonNumber = item.seasonNumber ?? undefined;

		if (item.episodeIds && item.episodeIds.length > 0) {
			const firstEp = mediaMaps.episodes.get(item.episodeIds[0]);
			if (firstEp) {
				const episodeNumber = firstEp.episodeNumber;
				const endEp = mediaMaps.episodes.get(item.episodeIds[item.episodeIds.length - 1]);
				const mediaTitle =
					seasonNumber !== undefined
						? item.episodeIds.length > 1
							? `${s.title} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}-E${String(endEp?.episodeNumber).padStart(2, '0')}`
							: `${s.title} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`
						: `${s.title} E${String(episodeNumber).padStart(2, '0')}`;

				return {
					mediaType: 'episode',
					mediaId: firstEp.id,
					mediaTitle,
					mediaYear: s.year,
					seriesId: item.seriesId,
					seriesTitle: s.title,
					seasonNumber,
					episodeNumber
				};
			}
		}

		return {
			mediaType: 'episode',
			mediaId: s.id,
			mediaTitle: item.seasonNumber ? `${s.title} Season ${item.seasonNumber}` : s.title,
			mediaYear: s.year,
			seriesId: item.seriesId,
			seriesTitle: s.title,
			seasonNumber
		};
	}

	return {
		...deriveFallbackMediaInfo(
			item.title,
			Boolean(item.seriesId || (item.episodeIds?.length ?? 0) > 0 || item.seasonNumber)
		),
		mediaId: ''
	};
}

export function resolveMonitoringMediaInfo(
	mon: MonitoringHistoryRecord,
	mediaMaps: MediaMaps
): ResolvedMediaInfo {
	if (mon.movieId && mediaMaps.movies.has(mon.movieId)) {
		const movie = mediaMaps.movies.get(mon.movieId)!;
		return {
			mediaType: 'movie',
			mediaId: movie.id,
			mediaTitle: movie.title,
			mediaYear: movie.year
		};
	}

	// Resolve series ID: prefer the stored value, fall back to bridging via episodeId
	// (older monitoringHistory rows written before seriesId was populated at the source)
	const resolvedSeriesId =
		mon.seriesId ?? (mon.episodeId ? mediaMaps.episodes.get(mon.episodeId)?.seriesId : undefined);

	if (resolvedSeriesId && mediaMaps.series.has(resolvedSeriesId)) {
		const s = mediaMaps.series.get(resolvedSeriesId)!;
		const seasonNumber = mon.seasonNumber ?? undefined;

		if (mon.episodeId && mediaMaps.episodes.has(mon.episodeId)) {
			const ep = mediaMaps.episodes.get(mon.episodeId)!;
			return {
				mediaType: 'episode',
				mediaId: ep.id,
				mediaTitle:
					seasonNumber !== undefined
						? `${s.title} S${String(seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`
						: `${s.title} E${String(ep.episodeNumber).padStart(2, '0')}`,
				mediaYear: s.year,
				seriesId: resolvedSeriesId,
				seriesTitle: s.title,
				seasonNumber,
				episodeNumber: ep.episodeNumber
			};
		}

		return {
			mediaType: 'episode',
			mediaId: s.id,
			mediaTitle: mon.seasonNumber ? `${s.title} Season ${mon.seasonNumber}` : s.title,
			mediaYear: s.year,
			seriesId: resolvedSeriesId,
			seriesTitle: s.title,
			seasonNumber
		};
	}

	return {
		...deriveFallbackMediaInfo(mon.releaseGrabbed, Boolean(mon.seriesId || mon.episodeId)),
		mediaId: ''
	};
}

export function buildFailedQueueIndex(
	queueItems: Pick<DownloadQueueRecord, 'id' | 'downloadId' | 'title' | 'addedAt'>[]
): Map<string, string> {
	const index = new Map<string, string>();

	for (const item of queueItems) {
		if (item.downloadId) {
			index.set(`download:${item.downloadId}`, item.id);
		}
		if (item.title && item.addedAt) {
			index.set(`title:${item.title.toLowerCase()}|grabbed:${item.addedAt}`, item.id);
		}
	}

	return index;
}

export function findFailedQueueItemId(
	history: DownloadHistoryRecord,
	failedQueueIndex?: Map<string, string>
): string | undefined {
	if (!failedQueueIndex) return undefined;

	if (history.downloadId) {
		const byDownloadId = failedQueueIndex.get(`download:${history.downloadId}`);
		if (byDownloadId) return byDownloadId;
	}

	if (history.title && history.grabbedAt) {
		return failedQueueIndex.get(
			`title:${history.title.toLowerCase()}|grabbed:${history.grabbedAt}`
		);
	}

	return undefined;
}

export interface BlocklistEntryInfo {
	createdAt: string | null;
	reason: string;
	expiresAt: string | null;
}

/**
 * Index blocklist rows by the same identity (title + associated movie/series)
 * BlocklistService.addToBlocklist dedupes on, so a history/queue item can be
 * matched back to its blocklist entry without a per-item query.
 */
export interface BlocklistIndexRow extends BlocklistEntryInfo {
	title: string;
	movieId: string | null;
	seriesId: string | null;
}

export function buildBlocklistIndex(entries: BlocklistIndexRow[]): Map<string, BlocklistEntryInfo> {
	const index = new Map<string, BlocklistEntryInfo>();
	for (const entry of entries) {
		const key = `${entry.title.toLowerCase()}|${entry.movieId ?? ''}|${entry.seriesId ?? ''}`;
		index.set(key, {
			createdAt: entry.createdAt,
			reason: entry.reason,
			expiresAt: entry.expiresAt
		});
	}
	return index;
}

export function findBlocklistEntry(
	item: { title: string | null; movieId?: string | null; seriesId?: string | null },
	blocklistIndex?: Map<string, BlocklistEntryInfo>
): BlocklistEntryInfo | undefined {
	if (!blocklistIndex || !item.title) return undefined;
	const key = `${item.title.toLowerCase()}|${item.movieId ?? ''}|${item.seriesId ?? ''}`;
	return blocklistIndex.get(key);
}

export function isBlocklistEntryActive(entry: BlocklistEntryInfo): boolean {
	return !entry.expiresAt || new Date(entry.expiresAt).getTime() > Date.now();
}

export function buildHistoryTimeline(
	history: DownloadHistoryRecord,
	blocklistEntry?: BlocklistEntryInfo
): ActivityEvent[] {
	const timeline: ActivityEvent[] = [];

	if (history.grabbedAt) {
		timeline.push({ type: 'grabbed', timestamp: history.grabbedAt });
	}
	if (history.completedAt) {
		timeline.push({ type: 'completed', timestamp: history.completedAt });
	}
	if (history.importedAt && history.status === 'imported') {
		timeline.push({ type: 'imported', timestamp: history.importedAt });
	}
	if (history.status === 'failed' && history.createdAt) {
		timeline.push({
			type: 'failed',
			timestamp: history.createdAt,
			details: history.statusReason ?? undefined
		});
	}
	if (history.status === 'rejected' && history.createdAt) {
		timeline.push({
			type: 'rejected',
			timestamp: history.createdAt,
			details: history.statusReason ?? undefined
		});
	}
	if (blocklistEntry?.createdAt) {
		timeline.push({
			type: 'blocklisted',
			timestamp: blocklistEntry.createdAt,
			details:
				blocklistEntry.reason === 'manual' ? 'Manually added to blocklist' : blocklistEntry.reason
		});
	}

	timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return timeline;
}

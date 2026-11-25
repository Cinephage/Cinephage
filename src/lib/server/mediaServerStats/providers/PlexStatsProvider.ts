import type {
	MediaServerStatsProvider,
	MediaServerStatsProviderConfig,
	SyncedMediaItem,
	SyncResult
} from '../types.js';
import { buildPlexHdrLabel } from '../hdr-normalize.js';
import {
	dedupeStreamsByLanguage,
	normalizeLanguageLists,
	pickPrimaryStream
} from '../language-normalize.js';

const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export class PlexStatsProvider implements MediaServerStatsProvider {
	constructor(private config: MediaServerStatsProviderConfig) {}

	async fetchAllItems(): Promise<SyncResult> {
		const sections = await this.getLibrarySections();
		const items: SyncedMediaItem[] = [];

		for (const section of sections) {
			if (section.type === 'movie') {
				const movies = await this.fetchLibraryItems(section.key, 1);
				for (const raw of movies) {
					items.push(this.normalizeItem(raw, 'movie'));
				}
			} else if (section.type === 'artist') {
				const tracks = await this.fetchLibraryItems(section.key, 10);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				for (const raw of tracks) {
					items.push(this.normalizeItem(raw, 'track'));
				}
			} else if (section.type === 'show') {
				// Plex attaches only EPISODE-scoped ids to episode Guid arrays
				// (tmdb://<episode-id> per the metadata provider spec), while local
				// reconciliation keys episodes by SERIES tmdbId + season + episode.
				// Fetch the show rows so each episode can inherit its series id,
				// mirroring the Jellyfin/Emby backfill in EmbyCompatibleProvider.
				const shows = await this.fetchLibraryItems(section.key, 2);
				const seriesTmdbByRatingKey = new Map<string, number | null>();
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				for (const raw of shows) {
					if (raw?.ratingKey != null) {
						seriesTmdbByRatingKey.set(String(raw.ratingKey), this.parseGuids(raw).tmdbId);
					}
				}

				const episodes = await this.fetchLibraryItems(section.key, 4);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				for (const raw of episodes) {
					const item = this.normalizeItem(raw, 'episode');
					const parentKey =
						raw?.grandparentRatingKey != null ? String(raw.grandparentRatingKey) : null;
					item.tmdbId = (parentKey ? seriesTmdbByRatingKey.get(parentKey) : null) ?? null;
					items.push(item);
				}
			}
		}

		return {
			items,
			serverItemIds: new Set(items.map((item) => item.serverItemId)),
			totalOnServer: items.length
		};
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async request(path: string): Promise<any> {
		const url = `${this.config.host}${path}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		try {
			const response = await fetch(url, {
				headers: {
					'X-Plex-Token': this.config.apiKey,
					Accept: 'application/json'
				},
				signal: controller.signal
			});

			if (!response.ok) {
				throw new Error(`Plex API error: ${response.status} ${response.statusText}`);
			}

			return response.json();
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async getLibrarySections(): Promise<Array<{ key: string; type: string; title: string }>> {
		const data = await this.request('/library/sections');
		const directories = this.asArray(data?.MediaContainer?.Directory);
		return (
			directories
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.filter((d: any) => d.key && d.type)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.map((d: any) => ({
					key: String(d.key),
					type: String(d.type),
					title: String(d.title ?? '')
				}))
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async fetchLibraryItems(sectionKey: string, itemType: number): Promise<any[]> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const allItems: any[] = [];
		let start = 0;

		while (true) {
			const data = await this.request(
				`/library/sections/${sectionKey}/all?type=${itemType}&includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}`
			);

			const metadata = this.asArray(data?.MediaContainer?.Metadata);
			const totalSize = Number(data?.MediaContainer?.totalSize ?? 0);

			allItems.push(...metadata);

			start += metadata.length;
			if (metadata.length === 0 || start >= totalSize) {
				break;
			}
		}

		return allItems;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private normalizeItem(raw: any, libraryType: 'movie' | 'episode' | 'track'): SyncedMediaItem {
		const guids = this.parseGuids(raw);
		// Deterministic enumeration (Phase 5): walk ALL Media versions and ALL of
		// their Parts in order instead of Media[0].Part[0], so multi-version/
		// multi-part files contribute their full stream set. Media-level fields
		// (resolution/container/bitrate fallbacks) keep the first version.
		const mediaList = this.asArray(raw?.Media);
		const primaryMedia = mediaList[0];
		const parts = mediaList.flatMap(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(m: any) => this.asArray(m?.Part)
		);
		const streams = parts.flatMap(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(p: any) => this.asArray(p?.Stream)
		);
		const hdrInfo = this.detectHDR(streams);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const videoStream = streams.find((s: any) => s.streamType === 1);
		// Audio/subtitle tracks dedupe by normalized language tag (first seen
		// wins) so repeated tracks across parts do not duplicate languages.
		const audioStreams = dedupeStreamsByLanguage(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			streams.filter((s: any) => s.streamType === 2),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(s: any) => s.languageCode
		);
		const subtitleStreams = dedupeStreamsByLanguage(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			streams.filter((s: any) => s.streamType === 3),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(s: any) => s.languageCode
		);

		// Primary = first stream flagged default/selected, else the first overall.
		const primaryAudio = pickPrimaryStream(audioStreams);

		// Canonical tags for the language arrays, untouched source codes kept raw.
		const audioLanguages = normalizeLanguageLists(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			audioStreams.map((s: any) => s.languageCode)
		);
		const subtitleLanguages = normalizeLanguageLists(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			subtitleStreams.map((s: any) => s.languageCode)
		);

		const _resolution = this.mapResolution(
			primaryMedia?.videoResolution,
			primaryMedia?.width,
			primaryMedia?.height
		);

		const duration = raw?.duration ? Math.round(Number(raw.duration) / 1000) : null;
		const lastViewedAt = raw?.lastViewedAt
			? new Date(Number(raw.lastViewedAt) * 1000).toISOString()
			: null;
		const playCount = raw?.viewCount != null ? Number(raw.viewCount) : 0;

		return {
			serverItemId: String(raw?.ratingKey ?? ''),
			tmdbId: guids.tmdbId,
			tvdbId: guids.tvdbId,
			imdbId: guids.imdbId,
			title: raw?.title ?? '',
			year: raw?.year != null ? Number(raw.year) : null,
			itemType: libraryType,
			artistName: libraryType === 'track' ? (raw?.grandparentTitle ?? null) : null,
			albumName: libraryType === 'track' ? (raw?.parentTitle ?? null) : null,
			seriesName: libraryType === 'track' ? null : (raw?.grandparentTitle ?? null),
			seasonNumber:
				libraryType === 'track' ? null : raw?.parentIndex != null ? Number(raw.parentIndex) : null,
			episodeNumber: libraryType === 'track' ? null : raw?.index != null ? Number(raw.index) : null,
			playCount,
			lastPlayedDate: lastViewedAt,
			playedPercentage: null,
			isPlayed: playCount > 0,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			videoCodec: videoStream?.codec ?? primaryMedia?.videoCodec ?? null,
			videoProfile: videoStream?.profile ?? null,
			videoBitDepth: videoStream?.bitDepth != null ? Number(videoStream.bitDepth) : null,
			width: primaryMedia?.width != null ? Number(primaryMedia.width) : null,
			height: primaryMedia?.height != null ? Number(primaryMedia.height) : null,
			isHDR: hdrInfo.isHDR,
			hdrFormat: hdrInfo.hdrFormat,
			videoBitrate: null,
			audioCodec: primaryAudio?.codec ?? primaryMedia?.audioCodec ?? null,
			audioChannels:
				primaryAudio?.channels != null
					? Number(primaryAudio.channels)
					: primaryMedia?.audioChannels != null
						? Number(primaryMedia.audioChannels)
						: null,
			audioChannelLayout: primaryAudio?.audioChannelLayout ?? null,
			audioBitrate: null,
			audioLanguages: audioLanguages.canonical,
			subtitleLanguages: subtitleLanguages.canonical,
			audioLanguagesRaw: audioLanguages.raw,
			subtitleLanguagesRaw: subtitleLanguages.raw,
			containerFormat: primaryMedia?.container ?? null,
			fileSize: parts[0]?.size != null ? Number(parts[0].size) : null,
			bitrate: primaryMedia?.bitrate != null ? Number(primaryMedia.bitrate) : null,
			duration
		};
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private parseGuids(metadata: any): {
		tmdbId: number | null;
		tvdbId: number | null;
		imdbId: string | null;
	} {
		const result = {
			tmdbId: null as number | null,
			tvdbId: null as number | null,
			imdbId: null as string | null
		};

		const guidArray = this.asArray(metadata?.Guid);

		for (const guid of guidArray) {
			const id = guid?.id;
			if (typeof id !== 'string') continue;

			if (id.startsWith('tmdb://')) {
				const parsed = parseInt(id.slice(7), 10);
				if (!isNaN(parsed)) result.tmdbId = parsed;
			} else if (id.startsWith('tvdb://')) {
				const parsed = parseInt(id.slice(7), 10);
				if (!isNaN(parsed)) result.tvdbId = parsed;
			} else if (id.startsWith('imdb://')) {
				result.imdbId = id.slice(7);
			}
		}

		if (result.tmdbId !== null || result.tvdbId !== null || result.imdbId !== null) {
			return result;
		}

		const guidString = metadata?.guid;
		if (typeof guidString === 'string') {
			const match = guidString.match(/(?:themoviedb|thetvdb|imdb):\/\/([^?]+)/);
			if (match) {
				const id = match[1];
				if (guidString.includes('themoviedb')) {
					const parsed = parseInt(id, 10);
					if (!isNaN(parsed)) result.tmdbId = parsed;
				} else if (guidString.includes('thetvdb')) {
					const parsed = parseInt(id, 10);
					if (!isNaN(parsed)) result.tvdbId = parsed;
				} else if (guidString.includes('imdb')) {
					result.imdbId = id;
				}
			}
		}

		return result;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private detectHDR(streams: any[]): { isHDR: boolean; hdrFormat: string | null } {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const videoStream = streams.find((s: any) => s.streamType === 1);
		if (!videoStream) return { isHDR: false, hdrFormat: null };

		const doViPresent =
			videoStream.DOVIPresent === true ||
			videoStream.DOVIPresent === 1 ||
			videoStream.DOVIPresent === '1';
		const doViProfile =
			videoStream.DOVIBLCompatID != null ? Number(videoStream.DOVIBLCompatID) : null;
		const colorTrc = String(videoStream.colorTrc ?? '');

		const label = buildPlexHdrLabel({ doViPresent, doViProfile, colorTrc });

		if (label) {
			return { isHDR: true, hdrFormat: label };
		}

		const allValues = Object.values(videoStream).map((v) => String(v ?? '').toLowerCase());
		const hasHDRKeyword = allValues.some(
			(v) => v.includes('hdr') || v.includes('dolbyvision') || v.includes('dolby vision')
		);

		if (hasHDRKeyword) {
			const hasDV = allValues.some((v) => v.includes('dolbyvision') || v.includes('dolby vision'));
			return { isHDR: true, hdrFormat: hasDV ? 'DV' : 'HDR10' };
		}

		return { isHDR: false, hdrFormat: null };
	}

	private mapResolution(
		label: string | null | undefined,
		width: number | null | undefined,
		height: number | null | undefined
	): string {
		if (label === '4k' || (width != null && Number(width) >= 3840)) return '4K';
		if (label === '1080' || (height != null && Number(height) >= 1080)) return '1080p';
		if (label === '720' || (height != null && Number(height) >= 720)) return '720p';
		if (label === '480' || (height != null && Number(height) >= 480)) return '480p';
		return 'SD';
	}

	private asArray<T>(value: T | T[] | undefined | null): T[] {
		if (!value) return [];
		return Array.isArray(value) ? value : [value];
	}
}

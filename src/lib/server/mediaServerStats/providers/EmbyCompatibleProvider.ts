import type {
	MediaServerStatsProvider,
	MediaServerStatsProviderConfig,
	SyncedMediaItem,
	SyncResult
} from '../types.js';
import {
	dedupeStreamsByLanguage,
	normalizeLanguageLists,
	pickPrimaryStream
} from '../language-normalize.js';

const PAGE_SIZE = 1000;
const TIMEOUT_MS = 30_000;
const ITEM_TYPES = 'Movie,Episode,Series';
const ITEM_FIELDS = 'MediaSources,MediaStreams,Path,Overview,ProviderIds';

const TYPE_MAP: Record<string, SyncedMediaItem['itemType']> = {
	Movie: 'movie',
	Episode: 'episode',
	Series: 'series'
};

export abstract class EmbyCompatibleProvider implements MediaServerStatsProvider {
	protected constructor(protected config: MediaServerStatsProviderConfig) {}

	abstract get serverName(): string;
	abstract buildUrl(path: string): string;
	abstract getAuthHeaders(): Record<string, string>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected abstract resolveHDR(videoStream: any | null): {
		isHDR: boolean;
		hdrFormat: string | null;
	};

	async fetchAllItems(): Promise<SyncResult> {
		const userId = await this.getAdminUserId();
		const items: SyncedMediaItem[] = [];
		let totalRecordCount: number;
		let offset = 0;

		// Maps for episode tmdbId backfill.
		// Jellyfin doesn't populate ProviderIds.Tmdb on episodes (TMDB identifies
		// episodes by series_id + season + episode, not standalone IDs). We fix this
		// by inheriting the parent series' tmdbId after all items are fetched.
		const seriesTmdbByJfId = new Map<string, number | null>();
		const episodeParentJfId = new Map<string, string>();

		do {
			const data = await this.request(
				`/Users/${userId}/Items?Recursive=true&IncludeItemTypes=${ITEM_TYPES}` +
					`&Fields=${ITEM_FIELDS}&EnableUserData=true&Limit=${PAGE_SIZE}&StartIndex=${offset}`
			);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const rawItems: any[] = data.Items ?? [];
			totalRecordCount = data.TotalRecordCount ?? 0;

			for (const raw of rawItems) {
				const normalized = this.normalizeItem(raw);
				if (normalized) {
					items.push(normalized);

					// Capture series tmdbId keyed by Jellyfin internal ID
					if (raw.Type === 'Series' && raw.Id) {
						seriesTmdbByJfId.set(String(raw.Id), normalized.tmdbId);
					}
					// Capture episode → parent series Jellyfin ID relationship
					if (raw.Type === 'Episode' && raw.Id && raw.SeriesId) {
						episodeParentJfId.set(String(raw.Id), String(raw.SeriesId));
					}
				}
			}

			offset += PAGE_SIZE;
		} while (offset < totalRecordCount);

		// Backfill: every episode's tmdbId is forced to its parent series'
		// tmdbId, overwriting whatever Jellyfin/Emby put in ProviderIds.Tmdb
		// on the episode itself. TMDB assigns each episode its own
		// standalone id (distinct from the show's id), and Jellyfin/Emby's
		// TMDB metadata plugin does populate that per-episode id on episode
		// items - not null, and not the show's id. Local reconciliation
		// keys episodes by SERIES tmdbId + season + episode number, so
		// leaving the per-episode id in place makes every episode look like
		// an unmatched item (never equal to the series tmdbId used
		// locally). Mirrors the Plex provider's equivalent fix in
		// PlexStatsProvider.ts.
		for (const item of items) {
			if (item.itemType !== 'episode') continue;
			const parentJfId = episodeParentJfId.get(item.serverItemId);
			item.tmdbId = (parentJfId ? seriesTmdbByJfId.get(parentJfId) : null) ?? null;
		}

		const serverItemIds = new Set<string>(items.map((item) => item.serverItemId));

		return {
			items,
			serverItemIds,
			totalOnServer: totalRecordCount
		};
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected async request(path: string): Promise<any> {
		const url = this.buildUrl(path);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

		try {
			const response = await fetch(url, {
				headers: {
					...this.getAuthHeaders(),
					Accept: 'application/json'
				},
				signal: controller.signal
			});

			if (!response.ok) {
				throw new Error(`${this.serverName} API error: ${response.status} ${response.statusText}`);
			}

			return response.json();
		} finally {
			clearTimeout(timeout);
		}
	}

	protected async getAdminUserId(): Promise<string> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const users: any[] = await this.request('/Users');
		const admin = users.find((u) => u.Policy?.IsAdministrator === true);
		if (!admin?.Id) {
			throw new Error(`No administrator user found on ${this.serverName} server`);
		}
		return admin.Id;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected normalizeItem(raw: any): SyncedMediaItem | null {
		if (!raw.Id || !raw.Name) {
			return null;
		}

		const itemType = TYPE_MAP[raw.Type];
		if (!itemType) {
			return null;
		}

		const providerIds = raw.ProviderIds ?? {};
		// Deterministic enumeration (Phase 5): walk ALL MediaSources in order
		// instead of MediaSources[0], so multi-version items contribute their full
		// stream set. Source-level fields (container/size/bitrate) keep the first
		// source.
		const mediaSources = this.asArray(raw.MediaSources);
		const primarySource = mediaSources[0] ?? null;
		const videoStream =
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			mediaSources.map((source: any) => this.getVideoStream(source)).find((v) => v != null) ?? null;
		// Audio/subtitle tracks dedupe by normalized language tag (first seen
		// wins) so repeated tracks across sources do not duplicate languages.
		const audioStreams = dedupeStreamsByLanguage(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			mediaSources.flatMap((source: any) => this.getAudioStreams(source)),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(s: any) => s.Language
		);
		const subtitleStreams = dedupeStreamsByLanguage(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			mediaSources.flatMap((source: any) => this.getSubtitleStreams(source)),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(s: any) => s.Language
		);

		// Primary = first stream flagged default/selected, else the first overall.
		const primaryAudio = pickPrimaryStream(audioStreams);

		// Canonical tags for the language arrays, untouched source strings kept raw.
		const audioLanguages = normalizeLanguageLists(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			audioStreams.map((s: any) => s.Language)
		);
		const subtitleLanguages = normalizeLanguageLists(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			subtitleStreams.map((s: any) => s.Language)
		);

		const { isHDR, hdrFormat } = this.resolveHDR(videoStream);

		// Movies identify by tmdbId alone; season/episode numbering is meaningless
		// for them. Some Jellyfin libraries populate IndexNumber/ParentIndexNumber
		// on movies, which would otherwise corrupt movie matching downstream.
		const useSeasonEpisode = itemType === 'episode';

		return {
			serverItemId: String(raw.Id),
			tmdbId: this.parseIntOrNull(providerIds.Tmdb),
			tvdbId: this.parseIntOrNull(providerIds.Tvdb),
			imdbId: providerIds.Imdb ?? null,
			title: raw.Name,
			year: raw.ProductionYear ?? null,
			itemType,
			seriesName: raw.SeriesName ?? null,
			seasonNumber: useSeasonEpisode ? (raw.ParentIndexNumber ?? null) : null,
			episodeNumber: useSeasonEpisode ? (raw.IndexNumber ?? null) : null,
			playCount: raw.UserData?.PlayCount ?? 0,
			lastPlayedDate: raw.UserData?.LastPlayedDate ?? null,
			playedPercentage: raw.UserData?.PlayedPercentage ?? null,
			isPlayed: raw.UserData?.Played ?? false,
			videoCodec: videoStream?.Codec ?? null,
			videoProfile: videoStream?.Profile ?? null,
			videoBitDepth: videoStream?.BitDepth ?? null,
			width: videoStream?.Width ?? null,
			height: videoStream?.Height ?? null,
			isHDR,
			hdrFormat,
			videoBitrate: videoStream?.BitRate ?? null,
			audioCodec: primaryAudio?.Codec ?? null,
			audioChannels: primaryAudio?.Channels ?? null,
			audioChannelLayout: primaryAudio?.ChannelLayout ?? null,
			audioBitrate: primaryAudio?.BitRate ?? null,
			audioLanguages: audioLanguages.canonical,
			subtitleLanguages: subtitleLanguages.canonical,
			audioLanguagesRaw: audioLanguages.raw,
			subtitleLanguagesRaw: subtitleLanguages.raw,
			containerFormat: primarySource?.Container ?? null,
			fileSize: primarySource?.Size ?? null,
			bitrate: primarySource?.Bitrate ?? null,
			duration: raw.RunTimeTicks ? raw.RunTimeTicks / 10_000_000 : null
		};
	}

	private asArray<T>(value: T | T[] | undefined | null): T[] {
		if (!value) return [];
		return Array.isArray(value) ? value : [value];
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected getVideoStream(mediaSource: any): any | null {
		const streams = mediaSource?.MediaStreams;
		if (!Array.isArray(streams)) return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return streams.find((s: any) => s.Type === 'Video') ?? null;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected getAudioStreams(mediaSource: any): any[] {
		const streams = mediaSource?.MediaStreams;
		if (!Array.isArray(streams)) return [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return streams.filter((s: any) => s.Type === 'Audio');
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected getSubtitleStreams(mediaSource: any): any[] {
		const streams = mediaSource?.MediaStreams;
		if (!Array.isArray(streams)) return [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return streams.filter((s: any) => s.Type === 'Subtitle');
	}

	protected parseIntOrNull(value: string | undefined): number | null {
		if (!value) return null;
		const parsed = parseInt(value, 10);
		return Number.isNaN(parsed) ? null : parsed;
	}
}

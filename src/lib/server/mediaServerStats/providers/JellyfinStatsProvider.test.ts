import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JellyfinStatsProvider } from './JellyfinStatsProvider.js';
import type { MediaServerStatsProviderConfig } from '../types.js';

const mockConfig: MediaServerStatsProviderConfig = {
	host: 'http://jellyfin:8096',
	apiKey: 'test-api-key',
	serverId: 'test-server-id',
	serverType: 'jellyfin'
};

function mockFetchResponse(data: any) {
	return {
		ok: true,
		json: () => Promise.resolve(data)
	};
}

function mockAdminResponse() {
	return mockFetchResponse([{ Id: 'admin-user-id', Policy: { IsAdministrator: true } }]);
}

function makeJellyfinItem(overrides: Record<string, any> = {}) {
	return {
		Id: 'item-1',
		Name: 'Test Movie',
		Type: 'Movie',
		ProductionYear: 2023,
		ProviderIds: {
			Tmdb: '12345',
			Tvdb: '67890',
			Imdb: 'tt1234567'
		},
		UserData: {
			PlayCount: 5,
			LastPlayedDate: '2025-01-01T00:00:00Z',
			PlayedPercentage: 85.5,
			Played: true
		},
		MediaSources: [
			{
				Container: 'mkv',
				Size: 10737418240,
				Bitrate: 20000000,
				MediaStreams: [
					{
						Type: 'Video',
						Codec: 'hevc',
						Profile: 'Main 10',
						BitDepth: 10,
						Width: 3840,
						Height: 2160,
						BitRate: 18000000,
						VideoRangeType: 'SDR'
					},
					{
						Type: 'Audio',
						Codec: 'dts',
						Channels: 6,
						ChannelLayout: '5.1',
						BitRate: 1500000,
						Language: 'eng'
					},
					{
						Type: 'Audio',
						Codec: 'aac',
						Channels: 2,
						ChannelLayout: 'stereo',
						BitRate: 256000,
						Language: 'fre'
					},
					{
						Type: 'Subtitle',
						Language: 'eng'
					},
					{
						Type: 'Subtitle',
						Language: 'spa'
					}
				]
			}
		],
		RunTimeTicks: 72000000000,
		...overrides
	};
}

describe('JellyfinStatsProvider', () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal('fetch', mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('should fetch admin user ID', async () => {
		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 0, Items: [] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		await provider.fetchAllItems();

		expect(mockFetch).toHaveBeenCalledWith(
			'http://jellyfin:8096/Users',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: expect.stringContaining('Token="test-api-key"')
				})
			})
		);
	});

	it('should fetch all items with pagination', async () => {
		const items = Array.from({ length: 5 }, (_, i) => makeJellyfinItem({ Id: `item-${i}` }));

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1500, Items: items.slice(0, 2) })
		);
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1500, Items: items.slice(2) })
		);

		const provider = new JellyfinStatsProvider({
			...mockConfig,
			host: 'http://jellyfin:8096'
		});
		const result = await provider.fetchAllItems();

		expect(mockFetch).toHaveBeenCalledTimes(3);
		expect(result.items).toHaveLength(5);
		expect(result.totalOnServer).toBe(1500);
	});

	it('should normalize movie items correctly', async () => {
		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1, Items: [makeJellyfinItem()] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const item = result.items[0];
		expect(item.serverItemId).toBe('item-1');
		expect(item.tmdbId).toBe(12345);
		expect(item.tvdbId).toBe(67890);
		expect(item.imdbId).toBe('tt1234567');
		expect(item.title).toBe('Test Movie');
		expect(item.year).toBe(2023);
		expect(item.itemType).toBe('movie');
		expect(item.playCount).toBe(5);
		expect(item.lastPlayedDate).toBe('2025-01-01T00:00:00Z');
		expect(item.playedPercentage).toBe(85.5);
		expect(item.isPlayed).toBe(true);
		expect(item.videoCodec).toBe('hevc');
		expect(item.videoProfile).toBe('Main 10');
		expect(item.videoBitDepth).toBe(10);
		expect(item.width).toBe(3840);
		expect(item.height).toBe(2160);
		expect(item.audioCodec).toBe('dts');
		expect(item.audioChannels).toBe(6);
		expect(item.audioChannelLayout).toBe('5.1');
		expect(item.containerFormat).toBe('mkv');
		expect(item.fileSize).toBe(10737418240);
		expect(item.duration).toBe(7200);
		expect(item.audioLanguages).toEqual(['en', 'fr']);
		expect(item.subtitleLanguages).toEqual(['en', 'es']);
		// Untouched source strings are preserved alongside the canonical tags.
		expect(item.audioLanguagesRaw).toEqual(['eng', 'fre']);
		expect(item.subtitleLanguagesRaw).toEqual(['eng', 'spa']);
	});

	it('should drop stray season/episode numbers on movies (covers shared EmbyCompatible base)', async () => {
		// Some Jellyfin libraries populate IndexNumber/ParentIndexNumber on movies.
		// Movies identify by tmdbId alone; keeping junk season/episode would split
		// one film into multiple storage_items rows during reconciliation. This also
		// covers Emby, which shares the EmbyCompatibleProvider.normalizeItem base.
		const movieWithJunk = makeJellyfinItem({
			IndexNumber: 1,
			ParentIndexNumber: 1
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1, Items: [movieWithJunk] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const item = result.items[0];
		expect(item.itemType).toBe('movie');
		expect(item.seasonNumber).toBeNull();
		expect(item.episodeNumber).toBeNull();
	});

	it('should handle missing media info gracefully', async () => {
		const bareItem = {
			Id: 'bare-item',
			Name: 'Bare Movie',
			Type: 'Movie'
		};

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 1, Items: [bareItem] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const item = result.items[0];
		expect(item.serverItemId).toBe('bare-item');
		expect(item.videoCodec).toBeNull();
		expect(item.playCount).toBe(0);
		expect(item.isPlayed).toBe(false);
		expect(item.tmdbId).toBeNull();
		expect(item.tvdbId).toBeNull();
		expect(item.imdbId).toBeNull();
		expect(item.audioCodec).toBeNull();
		expect(item.containerFormat).toBeNull();
		expect(item.fileSize).toBeNull();
		expect(item.duration).toBeNull();
		expect(item.audioLanguages).toEqual([]);
		expect(item.subtitleLanguages).toEqual([]);
	});

	it('should detect HDR from VideoRangeType', async () => {
		const hdrItem = makeJellyfinItem({
			MediaSources: [
				{
					Container: 'mkv',
					Size: 100,
					MediaStreams: [
						{
							Type: 'Video',
							Codec: 'hevc',
							VideoRangeType: 'HDR10'
						}
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 1, Items: [hdrItem] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items[0].isHDR).toBe(true);
		expect(result.items[0].hdrFormat).toBe('HDR10');
	});

	it('should normalize DOVIWithHDR10 to Dolby Vision HDR10', async () => {
		const dvItem = makeJellyfinItem({
			MediaSources: [
				{
					Container: 'mkv',
					MediaStreams: [
						{
							Type: 'Video',
							Codec: 'hevc',
							VideoRangeType: 'DOVIWithHDR10'
						}
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 1, Items: [dvItem] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items[0].isHDR).toBe(true);
		expect(result.items[0].hdrFormat).toBe('DVHDR10');
	});

	it('should normalize HDR10Plus', async () => {
		const item = makeJellyfinItem({
			MediaSources: [
				{
					Container: 'mkv',
					MediaStreams: [
						{
							Type: 'Video',
							Codec: 'hevc',
							VideoRangeType: 'HDR10Plus'
						}
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 1, Items: [item] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items[0].isHDR).toBe(true);
		expect(result.items[0].hdrFormat).toBe('HDR10+');
	});

	it('should normalize DOVIWithHDR10Plus to Dolby Vision HDR10+', async () => {
		const item = makeJellyfinItem({
			MediaSources: [
				{
					Container: 'mkv',
					MediaStreams: [
						{
							Type: 'Video',
							Codec: 'hevc',
							VideoRangeType: 'DOVIWithHDR10Plus'
						}
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 1, Items: [item] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items[0].isHDR).toBe(true);
		expect(result.items[0].hdrFormat).toBe('DVHDR10+');
	});

	it('should normalize DOVI to DV', async () => {
		const item = makeJellyfinItem({
			MediaSources: [
				{
					Container: 'mkv',
					MediaStreams: [
						{
							Type: 'Video',
							Codec: 'hevc',
							VideoRangeType: 'DOVI'
						}
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 1, Items: [item] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items[0].isHDR).toBe(true);
		expect(result.items[0].hdrFormat).toBe('DV');
	});

	it('should mark SDR as not HDR', async () => {
		const sdrItem = makeJellyfinItem({
			MediaSources: [
				{
					Container: 'mkv',
					MediaStreams: [
						{
							Type: 'Video',
							Codec: 'h264',
							VideoRangeType: 'SDR'
						}
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 1, Items: [sdrItem] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items[0].isHDR).toBe(false);
		expect(result.items[0].hdrFormat).toBeNull();
	});

	it('should extract audio and subtitle languages', async () => {
		const multilingualItem = makeJellyfinItem({
			MediaSources: [
				{
					Container: 'mkv',
					MediaStreams: [
						{ Type: 'Video', Codec: 'h264' },
						{ Type: 'Audio', Language: 'eng' },
						{ Type: 'Audio', Language: 'jpn' },
						{ Type: 'Audio', Language: '' },
						{ Type: 'Subtitle', Language: 'eng' },
						{ Type: 'Subtitle', Language: 'fre' },
						{ Type: 'Subtitle', Language: 'jpn' }
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1, Items: [multilingualItem] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items[0].audioLanguages).toEqual(['en', 'ja']);
		// The empty Language stream is dropped from both views.
		expect(result.items[0].audioLanguagesRaw).toEqual(['eng', 'jpn']);
		expect(result.items[0].subtitleLanguages).toEqual(['en', 'fr', 'ja']);
		expect(result.items[0].subtitleLanguagesRaw).toEqual(['eng', 'fre', 'jpn']);
	});

	it('should enumerate streams across all MediaSources deterministically (covers shared Emby base)', async () => {
		// Multi-version item: source 1 carries eng + fre audio and eng/fre subs;
		// source 2 repeats eng, adds jpn audio (flagged default) and a jpn sub.
		const multiVersionItem = makeJellyfinItem({
			Id: 'multi-source-1',
			Name: 'Multi Source Movie',
			MediaSources: [
				{
					Container: 'mkv',
					Size: 1000,
					Bitrate: 20000,
					MediaStreams: [
						{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
						{ Type: 'Audio', Codec: 'dts', Channels: 6, Language: 'eng' },
						{ Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'fre' },
						{ Type: 'Subtitle', Language: 'eng' },
						{ Type: 'Subtitle', Language: 'fre' }
					]
				},
				{
					Container: 'mp4',
					MediaStreams: [
						{ Type: 'Audio', Codec: 'eac3', Channels: 6, Language: 'eng' },
						{ Type: 'Audio', Codec: 'flac', Channels: 2, Language: 'jpn', IsDefault: true },
						{ Type: 'Subtitle', Language: 'jpn' }
					]
				}
			]
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1, Items: [multiVersionItem] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const item = result.items[0];
		// First-seen order across sources; duplicates collapse.
		expect(item.audioLanguages).toEqual(['en', 'fr', 'ja']);
		expect(item.audioLanguagesRaw).toEqual(['eng', 'fre', 'jpn']);
		expect(item.subtitleLanguages).toEqual(['en', 'fr', 'ja']);
		expect(item.subtitleLanguagesRaw).toEqual(['eng', 'fre', 'jpn']);
		// Primary audio = first default-flagged stream (the jpn flac track).
		expect(item.audioCodec).toBe('flac');
		expect(item.audioChannels).toBe(2);
		// Source-level fields still come from the first source.
		expect(item.containerFormat).toBe('mkv');
		expect(item.fileSize).toBe(1000);
		expect(item.bitrate).toBe(20000);
	});

	it('should handle empty library', async () => {
		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(mockFetchResponse({ TotalRecordCount: 0, Items: [] }));

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		expect(result.items).toHaveLength(0);
		expect(result.totalOnServer).toBe(0);
		expect(result.serverItemIds.size).toBe(0);
	});

	it('should parse provider IDs from ProviderIds object', async () => {
		const itemWithIds = makeJellyfinItem({
			ProviderIds: {
				Tmdb: '99999',
				Tvdb: '88888',
				Imdb: 'tt9999999'
			}
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1, Items: [itemWithIds] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const item = result.items[0];
		expect(item.tmdbId).toBe(99999);
		expect(item.tvdbId).toBe(88888);
		expect(item.imdbId).toBe('tt9999999');
	});

	it('should backfill episode tmdbId from parent series when ProviderIds.Tmdb is missing', async () => {
		// Jellyfin doesn't populate ProviderIds.Tmdb on episodes — only on series.
		// The provider should inherit the series tmdbId onto episodes via SeriesId.
		const seriesItem = makeJellyfinItem({
			Id: 'series-jf-1',
			Name: 'Breaking Bad',
			Type: 'Series',
			ProviderIds: { Tmdb: '1396' }
		});
		const episodeItem = makeJellyfinItem({
			Id: 'episode-jf-1',
			Name: 'Pilot',
			Type: 'Episode',
			SeriesName: 'Breaking Bad',
			SeriesId: 'series-jf-1',
			ParentIndexNumber: 1,
			IndexNumber: 1,
			ProviderIds: { Tvdb: '3415731' } // No Tmdb key — this is the real Jellyfin behavior
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 2, Items: [seriesItem, episodeItem] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const episode = result.items.find((i) => i.itemType === 'episode');
		expect(episode).toBeDefined();
		expect(episode!.tmdbId).toBe(1396); // Inherited from parent series
	});

	it('overrides a per-episode ProviderIds.Tmdb with the parent series tmdbId (#601)', async () => {
		// Some Jellyfin/Emby TMDB plugin versions DO populate ProviderIds.Tmdb
		// on episode items, but with the episode's own standalone TMDB id,
		// not the show's id. Local reconciliation keys episodes by SERIES
		// tmdbId + season + episode, so the raw per-episode id must never be
		// trusted - every episode has to inherit the parent series' tmdbId.
		const seriesItem = makeJellyfinItem({
			Id: 'series-jf-2',
			Name: 'Lanterns',
			Type: 'Series',
			ProviderIds: { Tmdb: '247718' }
		});
		const episodeItem = makeJellyfinItem({
			Id: 'episode-jf-2',
			Name: 'Episode One',
			Type: 'Episode',
			SeriesName: 'Lanterns',
			SeriesId: 'series-jf-2',
			ParentIndexNumber: 1,
			IndexNumber: 1,
			ProviderIds: { Tmdb: '5812394' } // the episode's OWN tmdb id, not the series'
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 2, Items: [seriesItem, episodeItem] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const episode = result.items.find((i) => i.itemType === 'episode');
		expect(episode).toBeDefined();
		expect(episode!.tmdbId).toBe(247718);
	});

	it('should leave episode tmdbId null when no matching series is found', async () => {
		const orphanEpisode = makeJellyfinItem({
			Id: 'episode-orphan',
			Name: 'Mystery Episode',
			Type: 'Episode',
			SeriesId: 'nonexistent-series',
			ProviderIds: {}
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 1, Items: [orphanEpisode] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const episode = result.items.find((i) => i.itemType === 'episode');
		expect(episode).toBeDefined();
		expect(episode!.tmdbId).toBeNull();
	});

	it('should backfill episode tmdbId across different series in one fetch', async () => {
		// Multiple series with their episodes — verifies the seriesId map correctly
		// routes each episode to its own parent series
		const series1 = makeJellyfinItem({
			Id: 'series-A',
			Name: 'Show A',
			Type: 'Series',
			ProviderIds: { Tmdb: '111' }
		});
		const series2 = makeJellyfinItem({
			Id: 'series-B',
			Name: 'Show B',
			Type: 'Series',
			ProviderIds: { Tmdb: '222' }
		});
		const ep1 = makeJellyfinItem({
			Id: 'ep-A-1',
			Name: 'A E1',
			Type: 'Episode',
			SeriesId: 'series-A',
			ParentIndexNumber: 1,
			IndexNumber: 1,
			ProviderIds: {}
		});
		const ep2 = makeJellyfinItem({
			Id: 'ep-B-1',
			Name: 'B E1',
			Type: 'Episode',
			SeriesId: 'series-B',
			ParentIndexNumber: 1,
			IndexNumber: 1,
			ProviderIds: {}
		});

		mockFetch.mockResolvedValueOnce(mockAdminResponse());
		mockFetch.mockResolvedValueOnce(
			mockFetchResponse({ TotalRecordCount: 4, Items: [series1, series2, ep1, ep2] })
		);

		const provider = new JellyfinStatsProvider(mockConfig);
		const result = await provider.fetchAllItems();

		const eps = result.items.filter((i) => i.itemType === 'episode');
		expect(eps).toHaveLength(2);
		expect(eps.find((e) => e.serverItemId === 'ep-A-1')!.tmdbId).toBe(111);
		expect(eps.find((e) => e.serverItemId === 'ep-B-1')!.tmdbId).toBe(222);
	});
});

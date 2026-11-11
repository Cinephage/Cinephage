import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { HttpResponse } from '#lib/server/indexers/http/index.js';
import { HttpError } from '#lib/server/indexers/http/index.js';
import { livetvAccounts, livetvCategories, livetvChannels } from '#lib/server/db/schema.js';
import type { LiveTvAccount } from '#lib/types/livetv.js';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const coreMocks = vi.hoisted(() => ({
	get: vi.fn(),
	refreshLatestIdentity: vi.fn(),
	toGatewayErrorMessage: vi.fn()
}));

vi.mock('#lib/server/cinephage/core/CinephageCore.js', () => ({
	getCinephageCore: () => coreMocks
}));

import { CinephageLiveProvider } from './CinephageLiveProvider';

const ACCOUNT_ID = 'account-1';

function httpResponse(body: unknown): HttpResponse {
	return {
		body: JSON.stringify(body),
		status: 200,
		headers: new Headers(),
		url: 'https://api.cinephage.net/api/v1/live'
	};
}

function makeAccount(): LiveTvAccount {
	const now = new Date().toISOString();
	return {
		id: ACCOUNT_ID,
		name: 'Cinephage Live',
		providerType: 'cinephage-live',
		enabled: true,
		playbackLimit: null,
		channelCount: null,
		categoryCount: null,
		expiresAt: null,
		serverTimezone: null,
		lastTestedAt: null,
		lastTestSuccess: null,
		lastTestError: null,
		lastSyncAt: null,
		lastSyncError: null,
		syncStatus: 'never',
		lastEpgSyncAt: null,
		lastEpgSyncError: null,
		epgProgramCount: 0,
		hasEpg: null,
		createdAt: now,
		updatedAt: now
	};
}

async function insertAccountRow(): Promise<void> {
	const now = new Date().toISOString();
	await testDb.db.insert(livetvAccounts).values({
		id: ACCOUNT_ID,
		name: 'Cinephage Live',
		providerType: 'cinephage-live',
		enabled: true,
		createdAt: now,
		updatedAt: now
	});
}

interface ChannelRowOptions {
	cinephageData?: {
		category?: string;
		countryCode?: string;
		feeds?: Array<{ source: string; channelId: string; name?: string }>;
	};
}

async function insertChannelRow(
	externalId: string,
	name: string,
	options: ChannelRowOptions = {}
): Promise<string> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	await testDb.db.insert(livetvChannels).values({
		id,
		accountId: ACCOUNT_ID,
		providerType: 'cinephage-live',
		externalId,
		name,
		cinephageData: options.cinephageData,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

function canonicalChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'ESPNUSA.cph',
		tvg_id: 'ESPNUSA.cph',
		name: 'ESPN USA',
		logo_url: 'https://cdn.example/espn.png',
		category: 'Sports',
		country_code: 'US',
		feeds: [{ source: 'daddylive', channel_id: '44', name: 'ESPN USA HD' }],
		...overrides
	};
}

function detailPayload(
	tvgId: string,
	options: { unwrap?: string | null } = {}
): Record<string, unknown> {
	return {
		channel: canonicalChannel({ id: tvgId, tvg_id: tvgId }),
		now: null,
		next: null,
		play: {
			channel_id: tvgId,
			source: 'daddylive',
			protocol: 'hls',
			playlist_url: `https://api.cinephage.net/api/v1/live/channel/x/${tvgId}/playlist.m3u8?t=sig`,
			expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			unwrap: options.unwrap ?? null
		}
	};
}

beforeEach(async () => {
	vi.clearAllMocks();
	coreMocks.get.mockRejectedValue(new Error('unexpected Cinephage API call'));
	await testDb.db.delete(livetvChannels);
	await testDb.db.delete(livetvCategories);
	await testDb.db.delete(livetvAccounts);
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('CinephageLiveProvider.testConnection', () => {
	it('reports canonical catalog counts on success', async () => {
		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/categories?view=canonical') {
				return httpResponse({ categories: ['Sports', 'News'] });
			}
			if (path === '/api/v1/live/channels?view=canonical&limit=1') {
				return httpResponse({ view: 'canonical', channels: [], total: 926 });
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const result = await new CinephageLiveProvider().testConnection(makeAccount());

		expect(result.success).toBe(true);
		expect(result.profile?.channelCount).toBe(926);
		expect(result.profile?.categoryCount).toBe(2);
	});

	it('self-heals and reports a friendly error on 401', async () => {
		coreMocks.get.mockRejectedValue(new HttpError(401, 'Unauthorized', new Headers()));
		// Registered branch of the real mapper: fires the self-heal itself.
		coreMocks.toGatewayErrorMessage.mockImplementation(async () => {
			await coreMocks.refreshLatestIdentity(true);
			return 'Cinephage API rejected authentication. Verify the configured version and commit.';
		});

		const result = await new CinephageLiveProvider().testConnection(makeAccount());

		expect(result.success).toBe(false);
		expect(result.error).toContain('rejected authentication');
		expect(coreMocks.toGatewayErrorMessage).toHaveBeenCalledTimes(1);
	});

	it('routes unregistered 401s to registration guidance', async () => {
		coreMocks.get.mockRejectedValue(new HttpError(401, 'Unauthorized', new Headers()));
		// Unregistered branch of the real mapper: registration guidance, no self-heal.
		coreMocks.toGatewayErrorMessage.mockImplementation(async () => {
			return 'Cinephage API requires a registered install key. Register this install under Settings → Cinephage Network.';
		});

		const result = await new CinephageLiveProvider().testConnection(makeAccount());

		expect(result.success).toBe(false);
		expect(result.error).toContain('Register this install');
		expect(coreMocks.refreshLatestIdentity).not.toHaveBeenCalled();
	});
});

describe('CinephageLiveProvider.resolveStreamUrl', () => {
	it('plays canonical channels through /channel/x/:tvgId and caches the payload', async () => {
		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/channel/x/ESPNUSA.cph')
				return httpResponse(detailPayload('ESPNUSA.cph'));
			throw new Error(`unexpected path: ${path}`);
		});

		const provider = new CinephageLiveProvider();
		const account = makeAccount();

		const first = await provider.resolveStreamUrl(account, { externalId: 'ESPNUSA.cph' });
		expect(first).toMatchObject({
			success: true,
			type: 'hls',
			url: 'https://api.cinephage.net/api/v1/live/channel/x/ESPNUSA.cph/playlist.m3u8?t=sig'
		});
		expect(first.headers).toBeUndefined();

		// Second resolution within the cache TTL must not re-hit the API.
		const second = await provider.resolveStreamUrl(account, { externalId: 'ESPNUSA.cph' });
		expect(second.success).toBe(true);
		expect(coreMocks.get).toHaveBeenCalledTimes(1);
	});

	it('attaches the zlive Referer to playlist and segment requests', async () => {
		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/channel/x/TRT1.tr') {
				return httpResponse(detailPayload('TRT1.tr', { unwrap: 'zlive-referer-1' }));
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const result = await new CinephageLiveProvider().resolveStreamUrl(makeAccount(), {
			externalId: 'TRT1.tr'
		});

		expect(result.success).toBe(true);
		expect(result.headers).toEqual({ Referer: 'https://zlive.st/' });
	});

	it('keeps pre-migration numeric rows on the legacy route', async () => {
		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/channel/44') {
				return httpResponse({
					...detailPayload('44'),
					play: {
						...(detailPayload('44').play as Record<string, unknown>),
						playlist_url: 'https://api.cinephage.net/api/v1/live/channel/44/playlist.m3u8?t=sig'
					}
				});
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const result = await new CinephageLiveProvider().resolveStreamUrl(makeAccount(), {
			externalId: '44'
		});

		expect(result).toMatchObject({
			success: true,
			url: 'https://api.cinephage.net/api/v1/live/channel/44/playlist.m3u8?t=sig'
		});
	});

	it('reports a gated source as a friendly 503 message', async () => {
		coreMocks.get.mockRejectedValue(new HttpError(503, 'Service Unavailable', new Headers()));

		const result = await new CinephageLiveProvider().resolveStreamUrl(makeAccount(), {
			externalId: 'ESPNUSA.cph'
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain('No playable source');
	});
});

describe('CinephageLiveProvider.syncChannels', () => {
	it('syncs the canonical view: categories, feeds, and stale removal', async () => {
		await insertAccountRow();
		await insertChannelRow('999', 'Stale Channel');

		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/categories?view=canonical') {
				return httpResponse({ categories: ['Sports'] });
			}
			if (path === '/api/v1/live/channels?view=canonical&limit=200&offset=0') {
				return httpResponse({
					view: 'canonical',
					channels: [canonicalChannel()],
					total: 1
				});
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const result = await new CinephageLiveProvider().syncChannels(ACCOUNT_ID);

		expect(result.success).toBe(true);
		expect(result.channelsAdded).toBe(1);
		expect(result.channelsRemoved).toBe(1);
		expect(result.categoriesAdded).toBe(1);

		const channels = await testDb.db
			.select()
			.from(livetvChannels)
			.where(eq(livetvChannels.accountId, ACCOUNT_ID));
		expect(channels).toHaveLength(1);
		const channel = channels[0];
		expect(channel).toMatchObject({
			externalId: 'ESPNUSA.cph',
			name: 'ESPN USA',
			providerType: 'cinephage-live',
			logo: 'https://cdn.example/espn.png',
			providerCategoryId: 'Sports',
			cinephageData: {
				category: 'Sports',
				countryCode: 'US',
				feeds: [{ source: 'daddylive', channelId: '44', name: 'ESPN USA HD' }]
			}
		});
		// The channel's taxonomy category links to the synced category row.
		const categories = await testDb.db
			.select()
			.from(livetvCategories)
			.where(eq(livetvCategories.accountId, ACCOUNT_ID));
		expect(categories).toHaveLength(1);
		expect(channel.categoryId).toBe(categories[0].id);

		const accounts = await testDb.db
			.select()
			.from(livetvAccounts)
			.where(eq(livetvAccounts.id, ACCOUNT_ID));
		expect(accounts[0]).toMatchObject({ syncStatus: 'success', channelCount: 1, categoryCount: 1 });
	});

	it('re-keys a pre-canonical row in place so lineup references survive', async () => {
		await insertAccountRow();
		const legacyId = await insertChannelRow('52', 'CBS USA');

		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/categories?view=canonical') {
				return httpResponse({ categories: [] });
			}
			if (path === '/api/v1/live/channels?view=canonical&limit=200&offset=0') {
				return httpResponse({
					view: 'canonical',
					channels: [
						canonicalChannel({
							id: 'CBSUSA.cph',
							tvg_id: 'CBSUSA.cph',
							name: 'CBS USA',
							category: null,
							country_code: 'US',
							feeds: [{ source: 'daddylive', channel_id: '52', name: 'CBS USA' }]
						})
					],
					total: 1
				});
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const result = await new CinephageLiveProvider().syncChannels(ACCOUNT_ID);

		expect(result.success).toBe(true);
		expect(result.channelsAdded).toBe(0);
		expect(result.channelsUpdated).toBe(1);
		expect(result.channelsRemoved).toBe(0);

		const channels = await testDb.db
			.select()
			.from(livetvChannels)
			.where(eq(livetvChannels.accountId, ACCOUNT_ID));
		expect(channels).toHaveLength(1);
		// Same primary key: the lineup item still points at this row.
		expect(channels[0].id).toBe(legacyId);
		expect(channels[0].externalId).toBe('CBSUSA.cph');
	});

	it('does not steal a row that is already another canonical channel', async () => {
		await insertAccountRow();
		const existingId = await insertChannelRow('TRT1.tr', 'TRT 1');

		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/categories?view=canonical') {
				return httpResponse({ categories: [] });
			}
			if (path === '/api/v1/live/channels?view=canonical&limit=200&offset=0') {
				return httpResponse({
					view: 'canonical',
					channels: [
						canonicalChannel({
							id: 'TRT1.tr',
							tvg_id: 'TRT1.tr',
							name: 'TRT 1',
							feeds: [{ source: 'daddylive', channel_id: '10' }]
						}),
						canonicalChannel({
							id: 'TRT2.tr',
							tvg_id: 'TRT2.tr',
							name: 'TRT 2',
							feeds: [{ source: 'daddylive', channel_id: 'TRT1.tr' }]
						})
					],
					total: 2
				});
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const result = await new CinephageLiveProvider().syncChannels(ACCOUNT_ID);

		expect(result.success).toBe(true);
		expect(result.channelsAdded).toBe(1);
		expect(result.channelsUpdated).toBe(1);

		const channels = await testDb.db
			.select()
			.from(livetvChannels)
			.where(eq(livetvChannels.accountId, ACCOUNT_ID));
		expect(channels.map((c) => c.externalId).sort()).toEqual(['TRT1.tr', 'TRT2.tr']);
		expect(channels.find((c) => c.externalId === 'TRT1.tr')?.id).toBe(existingId);
	});
});

describe('CinephageLiveProvider.fetchEpg failures', () => {
	it('throws when every schedule day fetch fails instead of reporting clean data', async () => {
		await insertAccountRow();
		await insertChannelRow('ESPNUSA.cph', 'ESPN USA');

		coreMocks.get.mockRejectedValue(new HttpError(503, 'Service Unavailable', new Headers()));

		await expect(
			new CinephageLiveProvider().fetchEpg(
				makeAccount(),
				new Date('2026-10-29T00:00:00Z'),
				new Date('2026-10-29T23:59:59Z')
			)
		).rejects.toThrow('schedule unavailable');
	});
});

describe('CinephageLiveProvider.fetchEpg', () => {
	it('maps feed ids to canonical channels and collapses duplicate feed references', async () => {
		await insertAccountRow();
		await insertChannelRow('ESPNUSA.cph', 'ESPN USA', {
			cinephageData: {
				feeds: [
					{ source: 'daddylive', channelId: '44' },
					{ source: 'zlive', channelId: '45' }
				]
			}
		});

		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/schedule?day=2026-10-29') {
				return httpResponse({
					day: '2026-10-29',
					events: [
						{
							id: 'event-1',
							source: 'daddylive',
							title: 'PERU Liga 1 : Final',
							category: 'LIVE NOW',
							day_key: '2026-10-29',
							starts_at: '2026-10-29T10:00:00Z',
							// Both feeds of the same channel in one event.
							channels: [
								{ id: '44', name: 'ESPN USA' },
								{ id: '45', name: 'ESPN USA (zlive)' }
							]
						},
						{
							id: 'event-2',
							source: 'daddylive',
							title: 'NBA : Tip-Off',
							category: 'NBA Basketball',
							day_key: '2026-10-29',
							starts_at: '2026-10-29T12:00:00Z',
							channels: [{ id: '44', name: 'ESPN USA' }]
						},
						{
							id: 'event-3',
							source: 'daddylive',
							title: 'EPG-only event',
							category: null,
							day_key: '2026-10-29',
							starts_at: '2026-10-29T14:00:00Z',
							channels: []
						},
						{
							id: 'event-4',
							source: 'daddylive',
							title: 'Unknown channel event',
							category: null,
							day_key: '2026-10-29',
							starts_at: '2026-10-29T10:00:00Z',
							channels: [{ id: 'not-synced', name: 'Ghost TV' }]
						}
					]
				});
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const programs = await new CinephageLiveProvider().fetchEpg(
			makeAccount(),
			new Date('2026-10-29T00:00:00Z'),
			new Date('2026-10-29T23:59:59Z')
		);

		expect(programs).toHaveLength(2);
		expect(programs.every((program) => program.externalChannelId === 'ESPNUSA.cph')).toBe(true);

		const [first, second] = programs.sort((a, b) => a.startTime.localeCompare(b.startTime));
		expect(first).toMatchObject({
			externalChannelId: 'ESPNUSA.cph',
			providerType: 'cinephage-live',
			title: 'PERU Liga 1 : Final',
			category: 'LIVE NOW',
			startTime: '2026-10-29T10:00:00.000Z',
			endTime: '2026-10-29T12:00:00.000Z',
			duration: 7200
		});
		// Last event of the window gets the fallback duration.
		expect(second.title).toBe('NBA : Tip-Off');
		expect(second.duration).toBe(3 * 60 * 60);
	});
});

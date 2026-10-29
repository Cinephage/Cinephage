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
	refreshLatestIdentity: vi.fn()
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

async function insertChannelRow(externalId: string, name: string): Promise<void> {
	const now = new Date().toISOString();
	await testDb.db.insert(livetvChannels).values({
		accountId: ACCOUNT_ID,
		providerType: 'cinephage-live',
		externalId,
		name,
		createdAt: now,
		updatedAt: now
	});
}

function playPayload(channelId: string): Record<string, unknown> {
	return {
		channel: { source: 'daddylive', id: channelId, name: 'ESPN USA', logo_url: null },
		now: null,
		next: null,
		play: {
			channel_id: channelId,
			source: 'daddylive',
			protocol: 'hls',
			playlist_url: `https://api.cinephage.net/api/v1/live/channel/${channelId}/playlist.m3u8?t=sig`,
			expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			unwrap: 'daddylive-camo-1'
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
	it('reports catalog counts on success', async () => {
		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/categories') {
				return httpResponse({ categories: ['LIVE NOW', 'NBA Basketball'] });
			}
			if (path === '/api/v1/live/channels?limit=1') {
				return httpResponse({ channels: [], total: 42 });
			}
			throw new Error(`unexpected path: ${path}`);
		});

		const result = await new CinephageLiveProvider().testConnection(makeAccount());

		expect(result.success).toBe(true);
		expect(result.profile?.channelCount).toBe(42);
		expect(result.profile?.categoryCount).toBe(2);
	});

	it('self-heals and reports a friendly error on 401', async () => {
		coreMocks.get.mockRejectedValue(new HttpError(401, 'Unauthorized', new Headers()));

		const result = await new CinephageLiveProvider().testConnection(makeAccount());

		expect(result.success).toBe(false);
		expect(result.error).toContain('rejected authentication');
		expect(coreMocks.refreshLatestIdentity).toHaveBeenCalledWith(true);
	});
});

describe('CinephageLiveProvider.resolveStreamUrl', () => {
	it('returns the signed playlist URL as HLS and caches the play payload', async () => {
		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/channel/44') return httpResponse(playPayload('44'));
			throw new Error(`unexpected path: ${path}`);
		});

		const provider = new CinephageLiveProvider();
		const account = makeAccount();

		const first = await provider.resolveStreamUrl(account, { externalId: '44' });
		expect(first).toMatchObject({
			success: true,
			type: 'hls',
			url: 'https://api.cinephage.net/api/v1/live/channel/44/playlist.m3u8?t=sig'
		});

		// Second resolution within the cache TTL must not re-hit the API.
		const second = await provider.resolveStreamUrl(account, { externalId: '44' });
		expect(second.success).toBe(true);
		expect(coreMocks.get).toHaveBeenCalledTimes(1);
	});
});

describe('CinephageLiveProvider.syncChannels', () => {
	it('upserts categories and channels and removes stale rows', async () => {
		await insertAccountRow();
		await insertChannelRow('999', 'Stale Channel');

		coreMocks.get.mockImplementation(async (path: string) => {
			if (path === '/api/v1/live/categories') {
				return httpResponse({ categories: ['Soccer'] });
			}
			if (path === '/api/v1/live/channels?limit=200&offset=0') {
				return httpResponse({
					channels: [
						{
							source: 'daddylive',
							id: '44',
							name: 'ESPN USA',
							logo_url: null,
							category: 'Soccer',
							country_code: 'US'
						}
					],
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
			externalId: '44',
			name: 'ESPN USA',
			providerType: 'cinephage-live',
			logo: null,
			providerCategoryId: 'Soccer',
			cinephageData: { category: 'Soccer', countryCode: 'US' }
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
});

describe('CinephageLiveProvider.fetchEpg', () => {
	it('maps schedule events to programs chained per channel', async () => {
		await insertAccountRow();
		await insertChannelRow('44', 'ESPN USA');

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
							channels: [{ id: '44', name: 'ESPN USA' }]
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
		const [first, second] = programs.sort((a, b) => a.startTime.localeCompare(b.startTime));

		expect(first).toMatchObject({
			externalChannelId: '44',
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

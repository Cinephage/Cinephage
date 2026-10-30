import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGatewaySigningState } from '#lib/server/cinephage/core/signing.js';
import type { LiveTvAccount } from '#lib/types/livetv.js';

const settingsMocks = vi.hoisted(() => ({
	getStreamingIndexerSettings: vi.fn()
}));

const coreMocks = vi.hoisted(() => ({
	refreshLatestIdentity: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return {};
	},
	get sqlite() {
		return {};
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/streaming/settings.js', () => ({
	getStreamingIndexerSettings: settingsMocks.getStreamingIndexerSettings
}));

vi.mock('#lib/server/cinephage/core/CinephageCore.js', () => ({
	getCinephageCore: () => coreMocks
}));

import { CinephageIptvProvider } from './CinephageIptvProvider';

const SECRET = 'a'.repeat(64);

function makeAccount(): LiveTvAccount {
	return {
		id: 'test',
		name: 'Test Account',
		providerType: 'cinephage-iptv',
		enabled: true,
		cinephageIptvConfig: { countries: ['de'] },
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
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
}

function jsonResponse(body: unknown, status: number, date?: string): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: date ? { date } : {}
	});
}

describe('CinephageIptvProvider gateway signing', () => {
	const provider = new CinephageIptvProvider();

	beforeEach(() => {
		resetGatewaySigningState();
		settingsMocks.getStreamingIndexerSettings.mockResolvedValue({
			cinephageVersion: '0.18.0',
			cinephageCommit: 'feedface'
		});
	});

	afterEach(() => {
		delete process.env.CINEPHAGE_SIGNING_SECRET;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		resetGatewaySigningState();
	});

	it('sends identity + signature headers with the query-carrying URL', async () => {
		process.env.CINEPHAGE_SIGNING_SECRET = SECRET;
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ channels: [], total: 0 }, 200));
		vi.stubGlobal('fetch', fetchMock);

		const result = await provider.testConnection(makeAccount());

		expect(result.success).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain('/api/v1/iptv/channels?');
		expect(url).toContain('limit=1');
		expect(url).toContain('country=de');
		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers['X-Cinephage-Version']).toBe('0.18.0');
		expect(headers['X-Cinephage-Commit']).toBe('feedface');
		expect(headers['X-Cinephage-Signature']).toMatch(/^[0-9a-f]{64}$/);
	});

	it('omits signature headers when no signing secret is configured', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ channels: [], total: 0 }, 200));
		vi.stubGlobal('fetch', fetchMock);

		const result = await provider.testConnection(makeAccount());

		expect(result.success).toBe(true);
		const headers = (fetchMock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
		expect(headers['X-Cinephage-Signature']).toBeUndefined();
		expect(headers['X-Cinephage-Version']).toBe('0.18.0');
	});

	it('retries once with a fresh signature after an invalid_signature 401', async () => {
		process.env.CINEPHAGE_SIGNING_SECRET = SECRET;
		const rejectionDate = new Date(Date.now() + 400_000);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(
					{ error: { details: { code: 'invalid_signature' } } },
					401,
					rejectionDate.toUTCString()
				)
			)
			.mockResolvedValueOnce(jsonResponse({ channels: [], total: 5 }, 200));
		vi.stubGlobal('fetch', fetchMock);

		const result = await provider.testConnection(makeAccount());

		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const firstTs = Number(
			(fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['X-Cinephage-Timestamp']
		);
		const secondTs = Number(
			(fetchMock.mock.calls[1][1]?.headers as Record<string, string>)['X-Cinephage-Timestamp']
		);
		expect(secondTs - firstTs).toBeGreaterThanOrEqual(399);
	});

	it('treats a non-signature 401 as an identity rejection (no retry)', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ error: { details: { code: 'unknown_release' } } }, 401));
		vi.stubGlobal('fetch', fetchMock);

		const result = await provider.testConnection(makeAccount());

		expect(result.success).toBe(false);
		expect(result.error).toContain('rejected authentication');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('reports the signing env var when the gateway demands a signature and none is set', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ error: { details: { code: 'signature_required' } } }, 401));
		vi.stubGlobal('fetch', fetchMock);

		const result = await provider.testConnection(makeAccount());

		expect(result.success).toBe(false);
		expect(result.error).toContain('CINEPHAGE_SIGNING_SECRET');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(coreMocks.refreshLatestIdentity).not.toHaveBeenCalled();
	});

	it('fails with the configuration message when identity settings are missing', async () => {
		settingsMocks.getStreamingIndexerSettings.mockResolvedValue(undefined);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await provider.testConnection(makeAccount());

		expect(result.success).toBe(false);
		expect(result.error).toContain('Cinephage API not configured');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

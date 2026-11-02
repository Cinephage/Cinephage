/**
 * Unit tests for OpenSubtitlesProvider authentication fix.
 *
 * Validates that search() and download() correctly authenticate before
 * making API requests when username+password credentials are provided.
 * (Bug #180: token was never set for search/download, only for test())
 *
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenSubtitlesProvider } from './OpenSubtitlesProvider';
import type { SubtitleProviderConfig } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SubtitleProviderConfig> = {}): SubtitleProviderConfig {
	return {
		id: 'test-opensubtitles',
		name: 'Test OpenSubtitles',
		implementation: 'opensubtitles',
		enabled: true,
		priority: 1,
		consecutiveFailures: 0,
		requestsPerMinute: 30,
		apiKey: 'test-api-key',
		...overrides
	};
}

/** Minimal valid search response */
const SEARCH_RESPONSE = {
	total_count: 1,
	data: [
		{
			id: '1',
			type: 'subtitle',
			attributes: {
				subtitle_id: '1',
				language: 'en',
				release: 'Inception.2010.BluRay',
				url: 'https://opensubtitles.com/1',
				files: [{ file_id: 123, file_name: 'Inception.srt' }],
				feature_details: { title: 'Inception', movie_name: 'Inception' },
				moviehash_match: false,
				hearing_impaired: false,
				foreign_parts_only: false,
				from_trusted: true,
				hd: true,
				download_count: 50000,
				ratings: 8,
				upload_date: '2010-01-01',
				uploader: { name: 'TestUploader' }
			}
		}
	]
};

/** Minimal valid download response */
const DOWNLOAD_RESPONSE = {
	link: 'https://dl.opensubtitles.com/file.srt',
	remaining: 19
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenSubtitlesProvider - authentication (Bug #180)', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('should send Authorization header on search() when username+password provided', async () => {
		const config = makeConfig({ username: 'user', password: 'pass' });
		const provider = new OpenSubtitlesProvider(config);

		// Track all fetch calls
		const fetchCalls: { url: string; headers: Record<string, string> }[] = [];

		vi.spyOn(provider, 'fetchWithTimeout').mockImplementation(
			async (url: string, options: RequestInit & { timeout?: number } = {}) => {
				const headers = (options?.headers ?? {}) as Record<string, string>;
				fetchCalls.push({ url, headers });

				if (url.includes('/login')) {
					return {
						ok: true,
						json: async () => ({
							token: 'jwt-token-123',
							base_url: 'https://api.opensubtitles.com/api/v1',
							user: { allowed_downloads: 20, vip: false }
						})
					} as Response;
				}

				return {
					ok: true,
					json: async () => SEARCH_RESPONSE
				} as Response;
			}
		);

		await provider.search({ title: 'Inception', year: 2010, languages: ['en'] });

		const loginCall = fetchCalls.find((c) => c.url.includes('/login'));
		const searchCall = fetchCalls.find((c) => c.url.includes('/subtitles'));

		expect(loginCall).toBeDefined();
		expect(searchCall).toBeDefined();
		expect(searchCall!.headers['Authorization']).toBe('Bearer jwt-token-123');
	});

	it('should NOT send Authorization header on search() when only API key provided', async () => {
		const config = makeConfig(); // no username/password
		const provider = new OpenSubtitlesProvider(config);

		const fetchCalls: { url: string; headers: Record<string, string> }[] = [];

		vi.spyOn(provider, 'fetchWithTimeout').mockImplementation(
			async (url: string, options: RequestInit & { timeout?: number } = {}) => {
				fetchCalls.push({ url, headers: (options?.headers ?? {}) as Record<string, string> });
				return { ok: true, json: async () => SEARCH_RESPONSE } as Response;
			}
		);

		await provider.search({ title: 'Inception', year: 2010, languages: ['en'] });

		const searchCall = fetchCalls.find((c) => c.url.includes('/subtitles'));
		expect(searchCall).toBeDefined();
		expect(searchCall!.headers['Authorization']).toBeUndefined();
		// Only the Api-Key header should be present
		expect(searchCall!.headers['Api-Key']).toBe('test-api-key');
	});

	it('should send Authorization header on download() when username+password provided', async () => {
		const config = makeConfig({ username: 'user', password: 'pass' });
		const provider = new OpenSubtitlesProvider(config);

		const fetchCalls: { url: string; headers: Record<string, string> }[] = [];

		vi.spyOn(provider, 'fetchWithTimeout').mockImplementation(
			async (url: string, options: RequestInit & { timeout?: number } = {}) => {
				fetchCalls.push({ url, headers: (options?.headers ?? {}) as Record<string, string> });

				if (url.includes('/login')) {
					return {
						ok: true,
						json: async () => ({
							token: 'jwt-token-456',
							base_url: 'https://api.opensubtitles.com/api/v1',
							user: { allowed_downloads: 20, vip: false }
						})
					} as Response;
				}
				if (url.includes('/download')) {
					return { ok: true, json: async () => DOWNLOAD_RESPONSE } as Response;
				}
				return {
					ok: true,
					arrayBuffer: async () => new ArrayBuffer(8)
				} as Response;
			}
		);

		await provider.download({
			providerId: 'test-opensubtitles',
			providerName: 'OpenSubtitles',
			providerSubtitleId: '123',
			language: 'en',
			title: 'Inception',
			releaseName: 'Inception.BluRay',
			isForced: false,
			isHearingImpaired: false,
			format: 'srt',
			isHashMatch: false,
			matchScore: 80,
			scoreBreakdown: {
				hashMatch: 0,
				titleMatch: 50,
				yearMatch: 20,
				releaseGroupMatch: 0,
				sourceMatch: 10,
				codecMatch: 0,
				hiPenalty: 0,
				forcedBonus: 0
			}
		});

		const downloadCall = fetchCalls.find((c) => c.url.includes('/download'));
		expect(downloadCall).toBeDefined();
		expect(downloadCall!.headers['Authorization']).toBe('Bearer jwt-token-456');
	});

	it('normalizes a VIP base_url returned as a bare hostname', async () => {
		// OpenSubtitles.com returns base_url as a bare hostname for VIP
		// accounts (e.g. "vip-api.opensubtitles.com") instead of a full URL -
		// no scheme, no /api/v1 path. Used as-is this breaks every request
		// after login with "Failed to parse URL from vip-api.opensubtitles.com/...".
		const config = makeConfig({ username: 'vip-user', password: 'pass' });
		const provider = new OpenSubtitlesProvider(config);

		const fetchCalls: { url: string }[] = [];

		vi.spyOn(provider, 'fetchWithTimeout').mockImplementation(async (url: string) => {
			fetchCalls.push({ url });

			if (url.includes('/login')) {
				return {
					ok: true,
					json: async () => ({
						token: 'vip-token',
						base_url: 'vip-api.opensubtitles.com',
						user: { allowed_downloads: 1000, vip: true }
					})
				} as Response;
			}

			return { ok: true, json: async () => SEARCH_RESPONSE } as Response;
		});

		await provider.search({ title: 'Inception', year: 2010, languages: ['en'] });

		const searchCall = fetchCalls.find((c) => c.url.includes('query='));
		expect(searchCall).toBeDefined();
		expect(searchCall!.url.startsWith('https://vip-api.opensubtitles.com/api/v1/')).toBe(true);
	});

	it('should cache token and not re-authenticate on repeated calls', async () => {
		const config = makeConfig({ username: 'user', password: 'pass' });
		const provider = new OpenSubtitlesProvider(config);

		let loginCount = 0;

		vi.spyOn(provider, 'fetchWithTimeout').mockImplementation(async (url: string) => {
			if (url.includes('/login')) {
				loginCount++;
				return {
					ok: true,
					json: async () => ({
						token: 'cached-token',
						base_url: 'https://api.opensubtitles.com/api/v1',
						user: { allowed_downloads: 20, vip: false }
					})
				} as Response;
			}
			return { ok: true, json: async () => SEARCH_RESPONSE } as Response;
		});

		await provider.search({ title: 'Inception', year: 2010, languages: ['en'] });
		await provider.search({ title: 'Inception', year: 2010, languages: ['en'] });

		// Login should only be called once — token is cached for 23h
		expect(loginCount).toBe(1);
	});
});

import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper.js';
import { indexers } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { LibraryStreamingModule } from './LibraryStreamingModule.js';
import { getCinephageSettingsService } from '../../settings/CinephageSettingsService.js';
import type { CinephageModuleContext } from '../../modules/types.js';

afterAll(() => {
	destroyTestDb(testDb);
});

const stubCtx: CinephageModuleContext = {
	getSubsystemConfig: async () => ({
		enabled: true,
		baseUrl: 'https://api.cinephage.net',
		versionOverride: null,
		commitOverride: null
	})
};

describe('LibraryStreamingModule', () => {
	let module: LibraryStreamingModule;
	const settings = getCinephageSettingsService();

	beforeEach(() => {
		// Wipe indexer + module rows for clean state
		testDb.db.delete(indexers).run();
		module = new LibraryStreamingModule(settings);
	});

	describe('identity', () => {
		it('has stable id library-streaming', () => {
			expect(module.id).toBe('library-streaming');
		});

		it('is stable maturity', () => {
			expect(module.maturity).toBe('stable');
		});

		it('declares providesIndexer capability for cinephage-stream', () => {
			expect(module.capabilities.providesIndexer?.definitionId).toBe('cinephage-stream');
		});
	});

	describe('init — seeds the cinephage-stream indexer row', () => {
		it('creates a new row when none exists', async () => {
			await module.init(stubCtx);
			const rows = testDb.db
				.select()
				.from(indexers)
				.where(eq(indexers.definitionId, 'cinephage-stream'))
				.all();
			expect(rows).toHaveLength(1);
			expect(rows[0].name).toBe('Cinephage Library');
			expect(rows[0].isBuiltIn).toBe(true);
			expect(rows[0].enabled).toBe(true);
		});

		it('marks the row as isBuiltIn on existing rows that lack the flag', async () => {
			// Simulate a pre-migration row that wasn't marked built-in
			testDb.db
				.insert(indexers)
				.values({
					name: 'Cinephage Library',
					definitionId: 'cinephage-stream',
					baseUrl: 'http://localhost',
					isBuiltIn: false,
					enabled: true
				})
				.run();

			await module.init(stubCtx);
			const rows = testDb.db
				.select()
				.from(indexers)
				.where(eq(indexers.definitionId, 'cinephage-stream'))
				.all();
			expect(rows).toHaveLength(1);
			expect(rows[0].isBuiltIn).toBe(true);
		});

		it('does not duplicate the row on re-init', async () => {
			await module.init(stubCtx);
			await module.init(stubCtx);
			const rows = testDb.db
				.select()
				.from(indexers)
				.where(eq(indexers.definitionId, 'cinephage-stream'))
				.all();
			expect(rows).toHaveLength(1);
		});
	});

	describe('isEnabled', () => {
		it('returns false when subsystem is disabled', async () => {
			await settings.updateConfig({ enabled: false });
			await module.refreshEnabledState();
			expect(module.isEnabled()).toBe(false);
			await settings.updateConfig({ enabled: true });
		});

		it('returns false when module is disabled', async () => {
			await settings.setModuleEnabled('library-streaming', false);
			await module.refreshEnabledState();
			expect(module.isEnabled()).toBe(false);
			await settings.setModuleEnabled('library-streaming', true);
		});

		it('returns true when both subsystem and module are enabled', async () => {
			await settings.updateConfig({ enabled: true });
			await settings.setModuleEnabled('library-streaming', true);
			await module.refreshEnabledState();
			expect(module.isEnabled()).toBe(true);
		});
	});

	describe('getSettings', () => {
		it('returns defaults when no settings stored', async () => {
			const s = await module.getSettings();
			expect(s.useHttps).toBe(false);
			expect(s.externalHost).toBe('');
		});

		it('returns stored useHttps/externalHost', async () => {
			await module.updateSettings({ useHttps: true, externalHost: 'media.example.com:8443' });
			const s = await module.getSettings();
			expect(s.useHttps).toBe(true);
			expect(s.externalHost).toBe('media.example.com:8443');
		});
	});

	describe('getBaseUrl', () => {
		it('derives https URL when useHttps is true', async () => {
			await module.updateSettings({ useHttps: true, externalHost: 'example.com' });
			expect(await module.getBaseUrl()).toBe('https://example.com');
		});

		it('derives http URL when useHttps is false', async () => {
			await module.updateSettings({ useHttps: false, externalHost: 'example.com' });
			expect(await module.getBaseUrl()).toBe('http://example.com');
		});

		it('strips accidental protocol prefix from externalHost', async () => {
			await module.updateSettings({ useHttps: false, externalHost: 'https://example.com' });
			expect(await module.getBaseUrl()).toBe('http://example.com');
		});

		it('returns null when externalHost is empty', async () => {
			await module.updateSettings({ useHttps: false, externalHost: '' });
			expect(await module.getBaseUrl()).toBeNull();
		});
	});

	describe('test', () => {
		it('returns failure when subsystem identity is not configured (no commit)', async () => {
			delete process.env.APP_COMMIT;
			const result = await module.test();
			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});

		it('returns success when identity resolves and health endpoint succeeds', async () => {
			process.env.APP_VERSION = '2.0.0';
			process.env.APP_COMMIT = 'feedface';
			// Mock the core's HTTP call by stubbing the core
			const fakeCore = {
				isEnabled: vi.fn().mockResolvedValue(true),
				getBaseUrl: vi.fn().mockResolvedValue('https://api.cinephage.net'),
				getIdentity: vi.fn().mockResolvedValue({
					version: '2.0.0',
					commit: 'feedface',
					isConfigured: true
				}),
				getAuthHeaders: vi.fn().mockResolvedValue({
					'X-Cinephage-Version': '2.0.0',
					'X-Cinephage-Commit': 'feedface'
				}),
				getHttpClient: vi.fn().mockReturnValue({
					get: vi.fn().mockResolvedValue({ status: 200 })
				})
			};
			const modWithFakeCore = new LibraryStreamingModule(settings, fakeCore as never);
			const result = await modWithFakeCore.test();
			expect(result.success).toBe(true);
			delete process.env.APP_VERSION;
			delete process.env.APP_COMMIT;
		});
	});

	describe('getStreams', () => {
		function createFakeCore(httpGet: ReturnType<typeof vi.fn>) {
			return {
				getBaseUrl: vi.fn().mockResolvedValue('https://api.cinephage.net'),
				getIdentity: vi.fn().mockResolvedValue({
					version: 'v0.15.0',
					commit: '8167446',
					isConfigured: true
				}),
				getAuthHeaders: vi.fn().mockResolvedValue({
					'X-Cinephage-Version': 'v0.15.0',
					'X-Cinephage-Commit': '8167446'
				}),
				getHttpClient: vi.fn().mockReturnValue({ get: httpGet }),
				toggleVersionFormat: vi.fn().mockResolvedValue(null),
				refreshLatestIdentity: vi.fn().mockResolvedValue(undefined)
			};
		}

		it('normalizes a dash source with string subtitles, requiresProxy and expiresAt', async () => {
			const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
			const httpGet = vi.fn().mockResolvedValue({
				status: 200,
				body: JSON.stringify({
					url: 'https://cdn.example.com/dash/abc_0_0_1080_h265_884/index.mpd',
					provider: 'Vidlink',
					quality: '1080p',
					protocol: 'dash',
					headers: {
						Cookie: 'CloudFront-Policy=xyz;CloudFront-Signature=abc;CloudFront-Key-Pair-Id=K1'
					},
					subtitles: ['https://cdn.example.com/sub/en.srt?signed'],
					requiresProxy: true,
					expiresAt: futureExpiry
				})
			});

			const mod = new LibraryStreamingModule(settings, createFakeCore(httpGet) as never);
			const result = await mod.getStreams({ tmdbId: 27205, type: 'movie' });

			expect(result.success).toBe(true);
			expect(result.sources).toHaveLength(1);
			const source = result.sources[0];
			expect(source.type).toBe('dash');
			expect(source.requiresProxy).toBe(true);
			expect(source.expiresAt).toBe(futureExpiry);
			expect(source.headers?.Cookie).toContain('CloudFront-Policy=xyz');
			expect(source.subtitles).toEqual([
				{ url: 'https://cdn.example.com/sub/en.srt?signed', label: 'und', language: 'und' }
			]);
		});

		it('keeps an obfuscated direct source as a file instead of assuming HLS', async () => {
			const httpGet = vi.fn().mockResolvedValue({
				status: 200,
				body: JSON.stringify({
					url: 'https://cdn.example.com/obfuscated/movie.jpeg?token=signed',
					provider: 'Direct',
					quality: '2160p',
					protocol: 'mkv',
					headers: { Referer: 'https://player.example.com/' }
				})
			});

			const mod = new LibraryStreamingModule(settings, createFakeCore(httpGet) as never);
			const result = await mod.getStreams({ tmdbId: 550, type: 'movie' });

			expect(result.success).toBe(true);
			expect(result.sources[0].type).toBe('file');
			expect(result.sources[0].sourceFormat).toBe('mkv');
			expect(result.sources[0].sourceContentType).toBe('video/x-matroska');
			expect(result.sources[0].requiresSegmentProxy).toBe(false);
		});

		it('toggles the version format and retries once on 401', async () => {
			const httpGet = vi
				.fn()
				.mockResolvedValueOnce({
					status: 401,
					body: JSON.stringify({ error: { message: 'Invalid or missing authentication' } })
				})
				.mockResolvedValueOnce({
					status: 200,
					body: JSON.stringify({
						url: 'https://cdn.example.com/master.m3u8',
						provider: 'Vidlink',
						quality: '1080p',
						protocol: 'hls',
						headers: {}
					})
				});

			const core = createFakeCore(httpGet);
			core.toggleVersionFormat = vi.fn().mockResolvedValue({
				version: '0.15.0',
				commit: '8167446',
				isConfigured: true
			});

			const mod = new LibraryStreamingModule(settings, core as never);
			const result = await mod.getStreams({ tmdbId: 603, type: 'movie' });

			expect(httpGet).toHaveBeenCalledTimes(2);
			expect(core.toggleVersionFormat).toHaveBeenCalledTimes(1);
			expect(result.success).toBe(true);
			expect(result.sources[0].type).toBe('hls');
		});

		it('falls back to an identity refresh when the 401 retry also fails', async () => {
			const httpGet = vi.fn().mockResolvedValue({
				status: 401,
				body: JSON.stringify({ error: { message: 'Invalid or missing authentication' } })
			});

			const core = createFakeCore(httpGet);
			core.toggleVersionFormat = vi.fn().mockResolvedValue({
				version: '0.15.0',
				commit: '8167446',
				isConfigured: true
			});

			const mod = new LibraryStreamingModule(settings, core as never);
			const result = await mod.getStreams({ tmdbId: 603, type: 'movie' });

			expect(httpGet).toHaveBeenCalledTimes(2);
			expect(core.refreshLatestIdentity).toHaveBeenCalledWith(true);
			expect(result.success).toBe(false);
			expect(result.error).toContain('rejected authentication');
		});

		it('sends refresh=1 to the gateway only when a refresh is requested', async () => {
			const httpGet = vi.fn().mockResolvedValue({
				status: 200,
				body: JSON.stringify({
					url: 'https://cdn.example.com/movie.mp4',
					provider: 'Vidlink',
					quality: '1080p',
					protocol: 'mp4',
					headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' },
					referer: ''
				})
			});

			const mod = new LibraryStreamingModule(settings, createFakeCore(httpGet) as never);
			await mod.getStreams({ tmdbId: 603, type: 'movie', refresh: true });
			expect(httpGet.mock.calls[0][0]).toContain('refresh=1');

			await mod.getStreams({ tmdbId: 603, type: 'movie' });
			expect(httpGet.mock.calls[1][0]).not.toContain('refresh=');
		});

		it('suppresses the Referer when the gateway sends an explicit empty referer', async () => {
			const httpGet = vi.fn().mockResolvedValue({
				status: 200,
				body: JSON.stringify({
					url: 'https://cdn.example.com/movie.mp4',
					provider: 'Vidlink',
					quality: '1080p',
					protocol: 'mp4',
					headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' },
					referer: ''
				})
			});

			const mod = new LibraryStreamingModule(settings, createFakeCore(httpGet) as never);
			const result = await mod.getStreams({ tmdbId: 603, type: 'movie' });

			expect(result.success).toBe(true);
			expect(result.sources[0].referer).toBe('');
		});

		it('suppresses and drops an empty headers referer, keeping the other headers', async () => {
			const httpGet = vi.fn().mockResolvedValue({
				status: 200,
				body: JSON.stringify({
					url: 'https://cdn.example.com/movie.mp4',
					provider: 'Vidlink',
					quality: '1080p',
					protocol: 'mp4',
					headers: {
						'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
						Origin: 'https://vidlink.pro',
						referer: ''
					}
				})
			});

			const mod = new LibraryStreamingModule(settings, createFakeCore(httpGet) as never);
			const result = await mod.getStreams({ tmdbId: 603, type: 'movie' });

			expect(result.success).toBe(true);
			const source = result.sources[0];
			expect(source.referer).toBe('');
			expect(source.headers?.['User-Agent']).toBe('VLC/3.0.20 LibVLC/3.0.20');
			expect(source.headers?.Origin).toBe('https://vidlink.pro');
			expect(source.headers?.referer).toBeUndefined();
			expect(source.headers?.Referer).toBeUndefined();
		});

		it('prefers an explicit referer over the headers and falls back to apiBaseUrl when silent', async () => {
			const explicit = vi.fn().mockResolvedValue({
				status: 200,
				body: JSON.stringify({
					url: 'https://cdn.example.com/master.m3u8',
					provider: 'Cinemabz',
					quality: '1080p',
					protocol: 'hls',
					headers: { Referer: 'https://from-headers.example.com/' },
					referer: 'https://from-field.example.com/'
				})
			});
			const silent = vi.fn().mockResolvedValue({
				status: 200,
				body: JSON.stringify({
					url: 'https://cdn.example.com/master.m3u8',
					provider: 'Cinemabz',
					quality: '1080p',
					protocol: 'hls'
				})
			});

			const explicitMod = new LibraryStreamingModule(settings, createFakeCore(explicit) as never);
			const explicitResult = await explicitMod.getStreams({ tmdbId: 603, type: 'movie' });
			expect(explicitResult.sources[0].referer).toBe('https://from-field.example.com/');

			const silentMod = new LibraryStreamingModule(settings, createFakeCore(silent) as never);
			const silentResult = await silentMod.getStreams({ tmdbId: 603, type: 'movie' });
			expect(silentResult.sources[0].referer).toBe('https://api.cinephage.net');
		});
	});
});

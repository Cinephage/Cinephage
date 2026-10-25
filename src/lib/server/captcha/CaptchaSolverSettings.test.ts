import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper';

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

const { CaptchaSolverSettingsService, captchaSolverSettingsService } =
	await import('./CaptchaSolverSettings');
const { DEFAULT_CONFIG } = await import('./types');
const { captchaSolverSettings } = await import('#lib/server/db/schema.js');

describe('CaptchaSolverSettingsService', () => {
	beforeEach(() => {
		testDb.db.delete(captchaSolverSettings).run();
		captchaSolverSettingsService.invalidateCache();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	describe('Singleton pattern', () => {
		it('should return the same instance', () => {
			const instance1 = CaptchaSolverSettingsService.getInstance();
			const instance2 = CaptchaSolverSettingsService.getInstance();

			expect(instance1).toBe(instance2);
		});

		it('should return same instance via exported singleton', () => {
			const instance = CaptchaSolverSettingsService.getInstance();
			expect(captchaSolverSettingsService).toBe(instance);
		});
	});

	describe('getConfig', () => {
		it('should return default config when no settings exist', () => {
			const config = captchaSolverSettingsService.getConfig();

			expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
			expect(config.timeoutSeconds).toBe(DEFAULT_CONFIG.timeoutSeconds);
			expect(config.cacheTtlSeconds).toBe(DEFAULT_CONFIG.cacheTtlSeconds);
			expect(config.headless).toBe(DEFAULT_CONFIG.headless);
			expect(config.proxy).toBeUndefined();
		});

		it('should parse boolean settings correctly', () => {
			testDb.db.insert(captchaSolverSettings).values({ key: 'enabled', value: 'false' }).run();
			testDb.db.insert(captchaSolverSettings).values({ key: 'headless', value: 'false' }).run();
			captchaSolverSettingsService.invalidateCache();

			const config = captchaSolverSettingsService.getConfig();

			expect(config.enabled).toBe(false);
			expect(config.headless).toBe(false);
		});

		it('should parse numeric settings correctly', () => {
			testDb.db
				.insert(captchaSolverSettings)
				.values({ key: 'timeout_seconds', value: '120' })
				.run();
			testDb.db
				.insert(captchaSolverSettings)
				.values({ key: 'cache_ttl_seconds', value: '7200' })
				.run();
			captchaSolverSettingsService.invalidateCache();

			const config = captchaSolverSettingsService.getConfig();

			expect(config.timeoutSeconds).toBe(120);
			expect(config.cacheTtlSeconds).toBe(7200);
		});

		it('should build proxy config from separate fields', () => {
			testDb.db
				.insert(captchaSolverSettings)
				.values({ key: 'proxy_url', value: 'http://proxy.example.com:8080' })
				.run();
			testDb.db
				.insert(captchaSolverSettings)
				.values({ key: 'proxy_username', value: 'user' })
				.run();
			testDb.db
				.insert(captchaSolverSettings)
				.values({ key: 'proxy_password', value: 'pass' })
				.run();
			captchaSolverSettingsService.invalidateCache();

			const config = captchaSolverSettingsService.getConfig();

			expect(config.proxy).toBeDefined();
			expect(config.proxy?.url).toBe('http://proxy.example.com:8080');
			expect(config.proxy?.username).toBe('user');
			expect(config.proxy?.password).toBe('pass');
		});

		it('should NOT create proxy config for empty proxy_url', () => {
			testDb.db.insert(captchaSolverSettings).values({ key: 'proxy_url', value: '' }).run();
			testDb.db
				.insert(captchaSolverSettings)
				.values({ key: 'proxy_username', value: 'user' })
				.run();
			captchaSolverSettingsService.invalidateCache();

			const config = captchaSolverSettingsService.getConfig();

			expect(config.proxy).toBeUndefined();
		});

		it('should return cached config on subsequent calls', () => {
			const config1 = captchaSolverSettingsService.getConfig();

			testDb.db.insert(captchaSolverSettings).values({ key: 'enabled', value: 'false' }).run();

			const config2 = captchaSolverSettingsService.getConfig();

			expect(config1.enabled).toBe(config2.enabled);
			expect(config2.enabled).toBe(true);
		});
	});

	describe('updateConfig', () => {
		it('should update boolean settings', () => {
			const result = captchaSolverSettingsService.updateConfig({ enabled: false });

			expect(result.enabled).toBe(false);

			captchaSolverSettingsService.invalidateCache();
			const config = captchaSolverSettingsService.getConfig();
			expect(config.enabled).toBe(false);
		});

		it('should update numeric settings', () => {
			const result = captchaSolverSettingsService.updateConfig({
				timeoutSeconds: 90,
				cacheTtlSeconds: 1800
			});

			expect(result.timeoutSeconds).toBe(90);
			expect(result.cacheTtlSeconds).toBe(1800);
		});

		it('should handle partial updates', () => {
			captchaSolverSettingsService.updateConfig({
				enabled: true,
				timeoutSeconds: 60
			});

			const result = captchaSolverSettingsService.updateConfig({ timeoutSeconds: 120 });

			expect(result.enabled).toBe(true);
			expect(result.timeoutSeconds).toBe(120);
		});

		it('should update proxy via proxyUrl field', () => {
			const result = captchaSolverSettingsService.updateConfig({
				proxyUrl: 'http://proxy.example.com:8080',
				proxyUsername: 'user',
				proxyPassword: 'pass'
			});

			expect(result.proxy?.url).toBe('http://proxy.example.com:8080');
			expect(result.proxy?.username).toBe('user');
			expect(result.proxy?.password).toBe('pass');
		});

		it('should update proxy via proxy object', () => {
			const result = captchaSolverSettingsService.updateConfig({
				proxy: {
					url: 'http://proxy2.example.com:3128',
					username: 'admin'
				}
			});

			expect(result.proxy?.url).toBe('http://proxy2.example.com:3128');
			expect(result.proxy?.username).toBe('admin');
		});

		it('should clear proxy when set to undefined', () => {
			captchaSolverSettingsService.updateConfig({
				proxy: { url: 'http://proxy.example.com:8080' }
			});

			const result = captchaSolverSettingsService.updateConfig({
				proxy: undefined
			});

			expect(result.proxy).toBeUndefined();
		});

		it('should invalidate cache after update', () => {
			captchaSolverSettingsService.updateConfig({ enabled: false });

			const config = captchaSolverSettingsService.getConfig();
			expect(config.enabled).toBe(false);
		});
	});

	describe('resetToDefaults', () => {
		it('should clear all settings and return defaults', () => {
			captchaSolverSettingsService.updateConfig({
				enabled: false,
				timeoutSeconds: 120,
				proxyUrl: 'http://proxy.example.com:8080'
			});

			const result = captchaSolverSettingsService.resetToDefaults();

			expect(result.enabled).toBe(DEFAULT_CONFIG.enabled);
			expect(result.timeoutSeconds).toBe(DEFAULT_CONFIG.timeoutSeconds);
			expect(result.proxy).toBeUndefined();
		});

		it('should persist the reset', () => {
			captchaSolverSettingsService.updateConfig({ enabled: false });
			captchaSolverSettingsService.resetToDefaults();

			const settings = testDb.db.select().from(captchaSolverSettings).all();
			expect(settings.length).toBe(0);
		});
	});

	describe('isEnabled', () => {
		it('should return true by default', () => {
			expect(captchaSolverSettingsService.isEnabled()).toBe(true);
		});

		it('should return false when disabled', () => {
			captchaSolverSettingsService.updateConfig({ enabled: false });
			expect(captchaSolverSettingsService.isEnabled()).toBe(false);
		});
	});

	describe('invalidateCache', () => {
		it('should force reload from database', () => {
			captchaSolverSettingsService.getConfig();

			testDb.db.insert(captchaSolverSettings).values({ key: 'enabled', value: 'false' }).run();

			captchaSolverSettingsService.invalidateCache();
			const config = captchaSolverSettingsService.getConfig();

			expect(config.enabled).toBe(false);
		});
	});
});

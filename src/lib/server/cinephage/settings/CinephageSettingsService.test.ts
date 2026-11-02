import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../test/db-helper.js';
import { cinephageApiConfig, cinephageApiModules } from '#lib/server/db/schema.js';
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

import { CinephageSettingsService } from './CinephageSettingsService.js';

afterAll(() => {
	destroyTestDb(testDb);
});

describe('CinephageSettingsService', () => {
	let service: CinephageSettingsService;

	beforeEach(() => {
		// Fresh service instance per test to avoid singleton leakage
		service = new CinephageSettingsService();
		// Wipe rows so each test starts from a clean state
		testDb.db.delete(cinephageApiConfig).run();
		testDb.db.delete(cinephageApiModules).run();
	});

	describe('getConfig', () => {
		it('returns defaults when no config row exists', async () => {
			const config = await service.getConfig();
			expect(config.enabled).toBe(true);
			expect(config.baseUrl).toBe('https://api.cinephage.net');
			expect(config.versionOverride).toBeNull();
			expect(config.commitOverride).toBeNull();
			expect(config.autoUpdate).toBe(true);
			expect(config.latestVersion).toBeNull();
			expect(config.latestCommit).toBeNull();
		});

		it('returns stored values when config row exists', async () => {
			await service.updateConfig({ enabled: false, versionOverride: 'v9.9.9' });
			const config = await service.getConfig();
			expect(config.enabled).toBe(false);
			expect(config.versionOverride).toBe('v9.9.9');
		});

		it('persists the auto-synced latest identity', async () => {
			await service.updateConfig({ latestVersion: '0.15.0', latestCommit: '8167446' });
			const config = await service.getConfig();
			expect(config.latestVersion).toBe('0.15.0');
			expect(config.latestCommit).toBe('8167446');
		});
	});

	describe('updateConfig', () => {
		it('creates singleton row on first update (upsert)', async () => {
			await service.updateConfig({ commitOverride: 'abc1234' });
			const rows = testDb.db.select().from(cinephageApiConfig).all();
			expect(rows).toHaveLength(1);
			expect(rows[0].id).toBe(1);
			expect(rows[0].commitOverride).toBe('abc1234');
		});

		it('preserves unmentioned fields on partial update', async () => {
			await service.updateConfig({ enabled: false, versionOverride: 'v1' });
			await service.updateConfig({ commitOverride: 'commit1' });
			const config = await service.getConfig();
			expect(config.enabled).toBe(false); // preserved
			expect(config.versionOverride).toBe('v1'); // preserved
			expect(config.commitOverride).toBe('commit1'); // updated
		});

		it('nulls out override fields when given null', async () => {
			await service.updateConfig({ versionOverride: 'v1', commitOverride: 'c1' });
			await service.updateConfig({ versionOverride: null });
			const config = await service.getConfig();
			expect(config.versionOverride).toBeNull();
			expect(config.commitOverride).toBe('c1');
		});
	});

	describe('getModuleConfig', () => {
		it('returns default state for unknown module', async () => {
			const mod = await service.getModuleConfig('does-not-exist');
			expect(mod.enabled).toBe(true); // modules default to enabled
			expect(mod.settings).toEqual({});
			expect(mod.lastError).toBeNull();
		});

		it('returns stored state for known module', async () => {
			await service.updateModuleSettings('library-streaming', { useHttps: true });
			const mod = await service.getModuleConfig('library-streaming');
			expect(mod.enabled).toBe(true);
			expect(mod.settings).toEqual({ useHttps: true });
		});
	});

	describe('setModuleEnabled', () => {
		it('toggles a module on', async () => {
			await service.setModuleEnabled('library-streaming', false);
			await service.setModuleEnabled('library-streaming', true);
			const mod = await service.getModuleConfig('library-streaming');
			expect(mod.enabled).toBe(true);
		});

		it('creates the row when toggling an unknown module', async () => {
			await service.setModuleEnabled('future-module', true);
			const rows = testDb.db
				.select()
				.from(cinephageApiModules)
				.where(eq(cinephageApiModules.moduleId, 'future-module'))
				.all();
			expect(rows).toHaveLength(1);
			expect(rows[0].enabled).toBe(true);
		});
	});

	describe('updateModuleSettings', () => {
		it('replaces settings entirely on update', async () => {
			await service.updateModuleSettings('library-streaming', { useHttps: true });
			await service.updateModuleSettings('library-streaming', { externalHost: 'foo' });
			const mod = await service.getModuleConfig('library-streaming');
			// Settings are replaced, not merged — modules own their full settings shape
			expect(mod.settings).toEqual({ externalHost: 'foo' });
		});
	});

	describe('recordModuleError / clearModuleError', () => {
		it('stores the error message', async () => {
			await service.recordModuleError('remote-streaming', 'upstream timeout');
			const mod = await service.getModuleConfig('remote-streaming');
			expect(mod.lastError).toBe('upstream timeout');
		});

		it('clears the error message', async () => {
			await service.recordModuleError('remote-streaming', 'fail');
			await service.clearModuleError('remote-streaming');
			const mod = await service.getModuleConfig('remote-streaming');
			expect(mod.lastError).toBeNull();
		});
	});
});

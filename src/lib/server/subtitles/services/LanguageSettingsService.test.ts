import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
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

const { LanguageSettingsService, getLanguageSettingsService, DEFAULT_LANGUAGE_SETTINGS } =
	await import('./LanguageSettingsService');

describe('LanguageSettingsService', () => {
	let settingsService: ReturnType<typeof LanguageSettingsService.getInstance>;

	beforeEach(() => {
		settingsService = LanguageSettingsService.getInstance();
		testDb.sqlite.prepare('DELETE FROM language_settings').run();
		testDb.sqlite.prepare('DELETE FROM language_profiles').run();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	describe('Singleton pattern', () => {
		it('should return the same instance', () => {
			const instance1 = LanguageSettingsService.getInstance();
			const instance2 = LanguageSettingsService.getInstance();

			expect(instance1).toBe(instance2);
		});

		it('should return same instance via helper function', () => {
			const instance1 = getLanguageSettingsService();
			const instance2 = getLanguageSettingsService();

			expect(instance1).toBe(instance2);
		});
	});

	describe('get', () => {
		it('should return defaults and materialize the singleton row on first access', async () => {
			const settings = await settingsService.get();

			expect(settings).toEqual(DEFAULT_LANGUAGE_SETTINGS);

			const rows = testDb.sqlite
				.prepare('SELECT id FROM language_settings WHERE id = ?')
				.all('singleton');
			expect(rows).toHaveLength(1);
		});

		it('should coerce malformed stored values defensively', async () => {
			testDb.sqlite
				.prepare(
					`INSERT INTO language_settings (id, metadata_locale, region, unknown_subtitle_policy, assumed_language, auto_sync_subtitles, prefer_original_title)
					 VALUES ('singleton', 'garbage!!', 'usa', 'bogus', NULL, 1, 1)`
				)
				.run();

			const settings = await settingsService.get();

			expect(settings.metadataLocale).toBe('en-US');
			expect(settings.region).toBe('US');
			expect(settings.unknownSubtitlePolicy).toBe('und');
			expect(settings.assumedLanguage).toBeNull();
			expect(settings.autoSyncSubtitles).toBe(true);
			expect(settings.defaultProfileId).toBeNull();
			expect(settings.discoverOriginalFilter).toBeNull();
			// Raw 0/1 storage is surfaced as a boolean.
			expect(settings.preferOriginalTitle).toBe(true);
		});
	});

	describe('update', () => {
		it('should persist a patch and canonicalize values', async () => {
			const updated = await settingsService.update({
				metadataLocale: 'pt-br',
				region: 'de',
				discoverOriginalFilter: 'eng',
				unknownSubtitlePolicy: 'assume-language',
				assumedLanguage: 'zh',
				autoSyncSubtitles: false
			});

			expect(updated.metadataLocale).toBe('pt-BR');
			expect(updated.region).toBe('DE');
			expect(updated.discoverOriginalFilter).toBe('en');
			expect(updated.unknownSubtitlePolicy).toBe('assume-language');
			expect(updated.assumedLanguage).toBe('zh');
			expect(updated.autoSyncSubtitles).toBe(false);
			// Untouched keys keep their defaults
			expect(updated.defaultProfileId).toBeNull();

			// And the values are persisted
			const settings = await settingsService.get();
			expect(settings.metadataLocale).toBe('pt-BR');
			expect(settings.region).toBe('DE');
		});

		it('should only change the provided keys', async () => {
			await settingsService.update({ region: 'jp' });

			const settings = await settingsService.get();
			expect(settings.region).toBe('JP');
			expect(settings.metadataLocale).toBe('en-US');
			expect(settings.autoSyncSubtitles).toBe(true);
			expect(settings.unknownSubtitlePolicy).toBe('und');
		});

		it('should persist the preferOriginalTitle instance default', async () => {
			// Defaults to false (show localized title).
			expect((await settingsService.get()).preferOriginalTitle).toBe(false);

			const updated = await settingsService.update({ preferOriginalTitle: true });
			expect(updated.preferOriginalTitle).toBe(true);
			expect((await settingsService.get()).preferOriginalTitle).toBe(true);

			// Untouched keys keep their values; other keys are unaffected by this one.
			await settingsService.update({ region: 'de' });
			expect((await settingsService.get()).preferOriginalTitle).toBe(true);
		});

		it('should allow clearing nullable values with null', async () => {
			await settingsService.update({ discoverOriginalFilter: 'fre' });
			expect((await settingsService.get()).discoverOriginalFilter).toBe('fr');

			await settingsService.update({ discoverOriginalFilter: null });
			expect((await settingsService.get()).discoverOriginalFilter).toBeNull();
		});

		it('should reduce the discover filter to its canonical base tag', async () => {
			await settingsService.update({ discoverOriginalFilter: 'zh-Hans' });
			expect((await settingsService.get()).discoverOriginalFilter).toBe('zh');

			await settingsService.update({ discoverOriginalFilter: 'en-US' });
			expect((await settingsService.get()).discoverOriginalFilter).toBe('en');
		});
	});

	describe('update validation', () => {
		it('should reject an invalid metadata locale', async () => {
			await expect(settingsService.update({ metadataLocale: 'not a locale!!' })).rejects.toThrow();
		});

		it('should reject an invalid region', async () => {
			await expect(settingsService.update({ region: 'USA' })).rejects.toThrow();
		});

		it('should reject an invalid unknown subtitle policy', async () => {
			await expect(
				// @ts-expect-error intentionally invalid value for the runtime schema
				settingsService.update({ unknownSubtitlePolicy: 'whatever' })
			).rejects.toThrow();
		});

		it('should reject an unresolvable discover filter', async () => {
			await expect(settingsService.update({ discoverOriginalFilter: '!!' })).rejects.toThrow();
		});

		it('should reject a non-boolean preferOriginalTitle', async () => {
			await expect(
				// @ts-expect-error intentionally invalid value for the runtime schema
				settingsService.update({ preferOriginalTitle: 'yes' })
			).rejects.toThrow();
		});
	});

	describe('getDefaultProfileId', () => {
		it('should return null when no default profile is configured', async () => {
			expect(await settingsService.getDefaultProfileId()).toBeNull();
		});

		it('should return the configured default profile id', async () => {
			const profileId = '11111111-1111-4111-8111-111111111111';
			testDb.sqlite
				.prepare(
					`INSERT INTO language_profiles (id, name, audio, subtitles, cutoff_rank, minimum_score, upgrades_allowed)
					 VALUES (?, 'Default', '{"preferOriginal":true,"languages":[],"mode":"prefer"}', '[{"tag":"en","variant":"regular","accessibility":"any"}]', NULL, 70, 1)`
				)
				.run(profileId);

			await settingsService.update({ defaultProfileId: profileId });

			expect(await settingsService.getDefaultProfileId()).toBe(profileId);
		});

		it('should reject a default profile id that does not exist', async () => {
			await expect(
				settingsService.update({ defaultProfileId: '11111111-1111-4111-8111-111111111111' })
			).rejects.toThrow(/not found/i);
		});
	});
});

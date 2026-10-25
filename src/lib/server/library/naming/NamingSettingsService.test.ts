import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../../test/db-helper';
import { DEFAULT_NAMING_PRESET_SELECTION } from '#lib/naming/editor-state.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { namingSettingsService } = await import('./NamingSettingsService');
const { namingSettings } = await import('#lib/server/db/schema.js');

describe('NamingSettingsService', () => {
	beforeEach(() => {
		testDb.db.delete(namingSettings).run();
		namingSettingsService.invalidateCache();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	it('returns default preset selection when nothing is stored', async () => {
		expect(await namingSettingsService.getPresetSelection()).toEqual(
			DEFAULT_NAMING_PRESET_SELECTION
		);
	});

	it('persists preset selection metadata with naming settings', async () => {
		const result = await namingSettingsService.updateSettings({
			config: {
				replaceSpacesWith: '',
				includeReleaseGroup: false
			},
			presetSelection: {
				selectedServerPresetId: 'jellyfin',
				selectedStylePresetId: 'scene',
				selectedDetailPresetId: 'balanced',
				selectedCustomPresetId: 'custom-1'
			}
		});

		expect(result.config.replaceSpacesWith).toBeUndefined();
		expect(result.config.includeReleaseGroup).toBe(false);
		expect(result.presetSelection).toEqual({
			selectedServerPresetId: 'jellyfin',
			selectedStylePresetId: 'scene',
			selectedDetailPresetId: 'balanced',
			selectedCustomPresetId: 'custom-1'
		});
	});

	it('reads back persisted settings from the database', async () => {
		await namingSettingsService.updateSettings({
			config: {
				replaceSpacesWith: '',
				includeReleaseGroup: false
			},
			presetSelection: {
				selectedServerPresetId: 'jellyfin',
				selectedStylePresetId: 'scene',
				selectedDetailPresetId: 'balanced',
				selectedCustomPresetId: 'custom-1'
			}
		});

		namingSettingsService.invalidateCache();

		const presetSelection = await namingSettingsService.getPresetSelection();
		expect(presetSelection.selectedServerPresetId).toBe('jellyfin');
		expect(presetSelection.selectedStylePresetId).toBe('scene');
		expect(presetSelection.selectedDetailPresetId).toBe('balanced');
		expect(presetSelection.selectedCustomPresetId).toBe('custom-1');
	});
});

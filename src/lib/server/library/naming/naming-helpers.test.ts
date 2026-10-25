/**
 * naming-helpers Tests
 *
 * Tests for buildMovieFolderName helper, including originalTitle support (WP-2).
 * These tests will FAIL until the originalTitle wiring change is made.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../../test/db-helper';
import { namingSettingsService } from './NamingSettingsService';
import { namingSettings } from '#lib/server/db/schema.js';

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

// Dynamic import after mock so the DB resolves to the test DB
const { buildMovieFolderName } = await import('./naming-helpers');

describe('buildMovieFolderName', () => {
	beforeEach(() => {
		// Clear naming settings between tests (not in core table list)
		testDb.db.delete(namingSettings).run();
		namingSettingsService.invalidateCache();
	});

	afterAll(() => {
		destroyTestDb(testDb);
	});

	describe('originalTitle parameter (WP-2)', () => {
		it('passes originalTitle through to the naming engine when format uses {OriginalTitle}', async () => {
			await namingSettingsService.updateConfig({
				movieFolderFormat: '{OriginalTitle} ({Year})'
			});
			namingSettingsService.invalidateCache();

			const result = buildMovieFolderName(
				'English Title',
				2024,
				12345,
				undefined,
				undefined,
				'Crouching Tiger, Hidden Dragon'
			);

			// Should contain the original title, not the English title
			expect(result).toContain('Crouching Tiger, Hidden Dragon');
			expect(result).toContain('2024');
			expect(result).not.toContain('English Title');
		});

		it('passes originalTitle through when format uses {OriginalCleanTitle}', async () => {
			await namingSettingsService.updateConfig({
				movieFolderFormat: '{OriginalCleanTitle} ({Year})'
			});
			namingSettingsService.invalidateCache();

			const result = buildMovieFolderName(
				'English Title',
				2024,
				12345,
				undefined,
				undefined,
				'Spirited Away (Sen to Chihiro no Kamikakushi)'
			);

			// {OriginalCleanTitle} strips filesystem-unsafe chars but preserves most content
			expect(result).toContain('Spirited Away');
			expect(result).toContain('Sen to Chihiro no Kamikakushi');
			expect(result).toContain('2024');
		});

		it('falls back to title when originalTitle is null', async () => {
			await namingSettingsService.updateConfig({
				movieFolderFormat: '{OriginalTitle} ({Year})'
			});
			namingSettingsService.invalidateCache();

			const result = buildMovieFolderName('English Title', 2024, 12345, undefined, undefined, null);

			// Should fall back to the English title
			expect(result).toContain('English Title');
			expect(result).toContain('2024');
		});

		it('falls back to title when originalTitle is undefined (not passed)', async () => {
			await namingSettingsService.updateConfig({
				movieFolderFormat: '{OriginalTitle} ({Year})'
			});
			namingSettingsService.invalidateCache();

			// Call WITHOUT the originalTitle parameter at all
			const result = buildMovieFolderName('English Title', 2024, 12345);

			// Should fall back to the English title
			expect(result).toContain('English Title');
			expect(result).toContain('2024');
		});

		it('default format uses English title even when originalTitle differs', async () => {
			// Default format uses {CleanTitle}, not {OriginalTitle}
			// Even if originalTitle is passed, the default format renders the English title
			namingSettingsService.invalidateCache();

			const result = buildMovieFolderName(
				'Star Wars',
				1977,
				11,
				undefined,
				undefined,
				'Star Wars: Episode IV - A New Hope'
			);

			// Default format uses {CleanTitle} — should render the first param (English title)
			expect(result).toContain('Star Wars');
			expect(result).toContain('1977');
		});

		it('handles Japanese originalTitle with {OriginalCleanTitle}', async () => {
			await namingSettingsService.updateConfig({
				movieFolderFormat: '{OriginalCleanTitle} ({Year})'
			});
			namingSettingsService.invalidateCache();

			const result = buildMovieFolderName(
				'Spirited Away',
				2001,
				129,
				undefined,
				undefined,
				'Sen to Chihiro no Kamikakushi'
			);

			expect(result).toContain('Sen to Chihiro no Kamikakushi');
			expect(result).toContain('2001');
		});
	});
});

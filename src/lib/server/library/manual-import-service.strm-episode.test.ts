/**
 * Regression for a bug where every .strm file in a season folder resolved
 * to the same (often S01E01) episode badge in the import wizard, even when
 * each file's own name carried the correct, distinct episode number. Root
 * cause: detectGroupFromPath unconditionally overrode a .strm file's
 * already-resolved per-file episode identifier with one derived from the
 * shared parent folder name, which has no per-episode info.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';

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
vi.mock('#lib/server/library/suggested-matches.js', () => ({
	findSuggestedMatches: vi.fn().mockResolvedValue([])
}));

const { manualImportService } = await import('./manual-import-service.js');

const service = manualImportService as unknown as {
	detectGroupFromPath: (
		groupPath: string,
		preferredMediaType: 'movie' | 'tv' | undefined,
		sourceRootPath: string,
		matchCache: Map<string, unknown>
	) => Promise<{ parsedSeason?: number; parsedEpisode?: number }>;
};

describe('ManualImportService .strm per-file episode resolution', () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'cinephage-strm-episode-'));
		const seasonDir = join(dir, 'Solo Leveling Season 2');
		await mkdir(seasonDir);
		await writeFile(
			join(seasonDir, 'Solo.Leveling.S02E01.1080p.WEB-DL.mkv.strm'),
			'https://example.invalid/1'
		);
		await writeFile(
			join(seasonDir, 'Solo.Leveling.S02E02.1080p.WEB-DL.mkv.strm'),
			'https://example.invalid/2'
		);
	});

	afterAll(async () => {
		destroyTestDb(testDb);
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it('resolves each .strm file to its own episode number, not the shared folder', async () => {
		const seasonDir = join(dir, 'Solo Leveling Season 2');
		const matchCache = new Map();

		const groupE1 = await service.detectGroupFromPath(
			join(seasonDir, 'Solo.Leveling.S02E01.1080p.WEB-DL.mkv.strm'),
			'tv',
			dir,
			matchCache
		);
		const groupE2 = await service.detectGroupFromPath(
			join(seasonDir, 'Solo.Leveling.S02E02.1080p.WEB-DL.mkv.strm'),
			'tv',
			dir,
			matchCache
		);

		expect(groupE1.parsedSeason).toBe(2);
		expect(groupE1.parsedEpisode).toBe(1);
		expect(groupE2.parsedSeason).toBe(2);
		expect(groupE2.parsedEpisode).toBe(2);
	});
});

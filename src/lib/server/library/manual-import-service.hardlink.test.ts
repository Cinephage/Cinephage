/**
 * Per-import hardlink override for manual imports (#584).
 *
 * transferSourceFile resolves preferHardlink as
 * override ?? global File Management setting, so the wizard can offer the
 * same hardlink control the settings page has, pinned per import. These
 * tests drive the real private method against a real temp filesystem so the
 * hardlink-vs-copy outcome is observed, not mocked.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, destroyTestDb } from '../../../test/db-helper';
import { manualImportService } from './manual-import-service.js';

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

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const service = manualImportService as unknown as {
	transferSourceFile: (
		sourcePath: string,
		destinationPath: string,
		preserveSymlinks: boolean,
		importModeOverride?: 'move' | 'copy' | 'symlink',
		preferHardlinkOverride?: boolean
	) => Promise<{ transferMode: string }>;
};

describe('ManualImportService per-import hardlink override (#584)', () => {
	let dir: string;
	let source: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'cinephage-hardlink-'));
		source = join(dir, 'source.mkv');
		await writeFile(source, 'manual-import-hardlink-fixture');
	});

	afterAll(async () => {
		destroyTestDb(testDb);
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it.each([
		{ override: true, expected: 'hardlink' },
		{ override: false, expected: 'copy' }
	])(
		'copy mode honors the per-import override (preferHardlink: $override)',
		async ({ override, expected }) => {
			const destination = join(dir, `dest-${expected}-${override}.mkv`);
			const result = await service.transferSourceFile(source, destination, false, 'copy', override);
			expect(result.transferMode).toBe(expected);
		}
	);

	it('falls back to the global setting when no override is sent', async () => {
		// Empty settings table -> schema defaults -> preferHardlink true,
		// same filesystem -> hardlink.
		const destination = join(dir, 'dest-global.mkv');
		const result = await service.transferSourceFile(source, destination, false, 'copy');
		expect(result.transferMode).toBe('hardlink');
	});
});

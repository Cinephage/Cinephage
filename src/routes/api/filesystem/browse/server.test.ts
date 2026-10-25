/**
 * Filesystem Browse API regression tests.
 *
 * Bug #495: opening a folder with thousands of subdirectories freezes the server.
 * Root cause: isManagedRootPath() re-resolves ALL configured root folders (sync DB
 * query + per-root mkdtemp write-test + 2x statfs) for EVERY subdirectory entry.
 * Regression guard: the root-folder resolution must happen once per request, not
 * once per directory entry.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../../../../test/api-helper';

const SUBDIR_COUNT = 300;

const rootFolderStats = vi.hoisted(() => ({
	instances: 0,
	getFoldersCalls: 0
}));

class MockRootFolderService {
	constructor() {
		rootFolderStats.instances++;
	}

	async getFolders(): Promise<unknown[]> {
		rootFolderStats.getFoldersCalls++;
		return [];
	}
}

vi.mock('#lib/server/downloadClients/RootFolderService.js', () => ({
	RootFolderService: MockRootFolderService
}));

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const { GET } = await import('./+server');

let testDir: string;

describe('Filesystem Browse API', () => {
	beforeEach(() => {
		rootFolderStats.instances = 0;
		rootFolderStats.getFoldersCalls = 0;
	});

	afterAll(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	it('resolves configured root folders exactly once per request, not once per directory entry (bug #495)', async () => {
		testDir = await mkdtemp(join(tmpdir(), 'cinephage-browse-test-'));
		await Promise.all(
			Array.from({ length: SUBDIR_COUNT }, (_, i) => mkdir(join(testDir, `subdir_${i}`)))
		);
		await writeFile(join(testDir, 'sample.mkv'), 'fake video');
		await writeFile(join(testDir, 'sample2.mkv'), 'fake video');

		const url = `http://localhost/api/filesystem/browse?path=${encodeURIComponent(testDir)}&includeFiles=true&fileFilter=video&excludeManagedRoots=true`;
		const { status, data } = await api.get<{
			entries: Array<{ name: string; isDirectory: boolean }>;
		}>(GET, { url });

		expect(status).toBe(200);
		expect(data.entries).toHaveLength(SUBDIR_COUNT + 2);

		// The bug: one full root-folder re-resolution PER subdirectory (plus the
		// two top-level boundary checks). Must be a small constant after the fix.
		expect(rootFolderStats.getFoldersCalls).toBeLessThanOrEqual(3);
	});
});

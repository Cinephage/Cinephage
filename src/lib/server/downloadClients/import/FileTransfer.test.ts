/**
 * FileTransfer.moveFile() Safety Tests
 *
 * Validates all safety guards: no-op for identical paths, parent-path
 * collision detection, source-first verification, and filesystem operations
 * against real temp directory files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { moveFile, fileExists, deletePhysicalFile, applyFilePermissions } from './FileTransfer';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stat } from 'node:fs/promises';

describe('moveFile safety guards', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'cinephage-movefile-test-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function createFile(name: string, content = 'test content'): Promise<string> {
		const path = join(tmpDir, name);
		await writeFile(path, content);
		return path;
	}

	describe('source === destination (no-op guard)', () => {
		it('returns success without deleting the file', async () => {
			const file = await createFile('movie.mkv', 'hello world');

			const result = await moveFile(file, file);

			expect(result.success).toBe(true);
			expect(result.mode).toBe('move');

			// File must still exist and have its original content.
			const stillExists = await fileExists(file);
			expect(stillExists).toBe(true);
			const s = await stat(file);
			expect(s.size).toBe(11);
		});

		it('returns success when paths differ syntactically but resolve identically', async () => {
			const file = await createFile('movie.mkv', 'hello world');
			// path/../path/movie.mkv resolves to path/movie.mkv
			const aliasedPath = join(tmpDir, '..', tmpDir.split('/').pop()!, 'movie.mkv');

			const result = await moveFile(file, aliasedPath);

			expect(result.success).toBe(true);
			const stillExists = await fileExists(file);
			expect(stillExists).toBe(true);
		});

		it('fails when source does not exist even when paths match', async () => {
			const nonexistent = join(tmpDir, 'does-not-exist.mkv');

			const result = await moveFile(nonexistent, nonexistent);

			expect(result.success).toBe(false);
			expect(result.error).toContain('does not exist');
		});
	});

	describe('source existence verification', () => {
		it('fails before deleting destination when source is missing', async () => {
			const dest = await createFile('existing-dest.mkv', 'dest content');
			const source = join(tmpDir, 'missing-source.mkv');

			const result = await moveFile(source, dest);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Source file not found');

			// Destination must be untouched.
			const destStillExists = await fileExists(dest);
			expect(destStillExists).toBe(true);
			const s = await stat(dest);
			expect(s.size).toBe(12);
		});
	});

	describe('parent-path collision guard', () => {
		it('refuses to move a file into its own descendant directory', async () => {
			const file = await createFile('movie.mkv', 'content');

			// Pretend file IS the directory we're trying to move into.
			// The collision check is: dest starts with source + '/'
			const destPath = join(file, 'nested', 'file.mkv');

			const result = await moveFile(file, destPath);

			expect(result.success).toBe(false);
			expect(result.error).toContain('child of the source path');
		});

		it('allows moves to unrelated directories', async () => {
			const source = await createFile('movie.mkv', 'content');
			const dest = join(tmpDir, 'other-dir', 'movie.mkv');

			const result = await moveFile(source, dest);

			expect(result.success).toBe(true);
			const stillExists = await fileExists(dest);
			expect(stillExists).toBe(true);
			const srcExists = await fileExists(source);
			expect(srcExists).toBe(false);
		});
	});

	describe('actual file move', () => {
		it('moves a file to a new path and removes source', async () => {
			const source = await createFile('source.mkv', 'hello world');
			const dest = join(tmpDir, 'sub', 'dest.mkv');

			const result = await moveFile(source, dest);

			expect(result.success).toBe(true);
			expect(result.mode).toBe('move');

			const destExists = await fileExists(dest);
			expect(destExists).toBe(true);
			const srcExists = await fileExists(source);
			expect(srcExists).toBe(false);

			const s = await stat(dest);
			expect(s.size).toBe(11);
		});

		it('creates deep missing destination parents (letter-bucket targets) and succeeds', async () => {
			const source = await createFile('movie.mkv', 'nested content');
			// Letter-bucket naming: T/Title (2026) [tmdbid-x]/movie.mkv —
			// neither T nor the title folder exists yet.
			const dest = join(tmpDir, 'T', 'Title (2026) [tmdbid-1]', 'movie.mkv');

			const result = await moveFile(source, dest);

			expect(result.success).toBe(true);
			expect(result.mode).toBe('move');
			expect(await fileExists(dest)).toBe(true);
			expect(await fileExists(source)).toBe(false);
			const s = await stat(dest);
			expect(s.size).toBe(14);
		});

		it('overwrites an existing destination when moving', async () => {
			const source = await createFile('source.mkv', 'new content');
			const dest = await createFile('dest.mkv', 'old content');

			const result = await moveFile(source, dest);

			expect(result.success).toBe(true);

			const destExists = await fileExists(dest);
			expect(destExists).toBe(true);
			const s = await stat(dest);
			expect(s.size).toBe(11); // new content
		});
	});

	describe('case-insensitive rename safety (Radarr pattern)', () => {
		it('handles case-only renames without data loss', async () => {
			const source = await createFile('Movie.mkv', 'case test content');
			// Same directory, different case
			const dest = join(tmpDir, 'movie.mkv');

			const result = await moveFile(source, dest);

			expect(result.success).toBe(true);

			// Because we're on a case-sensitive filesystem (Linux),
			// both can coexist as separate files. Verify the move worked.
			const destExists = await fileExists(dest);
			expect(destExists).toBe(true);

			const s = await stat(dest);
			expect(s.size).toBe(17);
		});
	});
});

describe('deletePhysicalFile', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'cinephage-deletephysical-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('unlinks the file when recycleEnabled is false', async () => {
		const filePath = join(tmpDir, 'movie.mkv');
		await writeFile(filePath, 'content');

		await deletePhysicalFile(filePath, false, tmpDir);

		expect(await fileExists(filePath)).toBe(false);
		// recycle bin must NOT have been created
		expect(await fileExists(join(tmpDir, '.trash'))).toBe(false);
	});

	it('moves the file to the recycle bin when recycleEnabled is true', async () => {
		const moviesDir = join(tmpDir, 'Movies');
		await mkdir(moviesDir, { recursive: true });
		const filePath = join(moviesDir, 'movie.mkv');
		await writeFile(filePath, 'content');

		await deletePhysicalFile(filePath, true, tmpDir);

		// original gone
		expect(await fileExists(filePath)).toBe(false);
		// recycle bin preserves path structure beneath root folder
		const trashPath = join(tmpDir, '.trash', 'Movies', 'movie.mkv');
		expect(await fileExists(trashPath)).toBe(true);
	});

	it('is a no-op when the file does not exist', async () => {
		const missing = join(tmpDir, 'nope.mkv');

		await expect(deletePhysicalFile(missing, false, tmpDir)).resolves.toBeUndefined();
		await expect(deletePhysicalFile(missing, true, tmpDir)).resolves.toBeUndefined();
	});
});

describe('applyFilePermissions', () => {
	let tmpDir: string;
	let originalUmask: number;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'cinephage-permissions-test-'));
		// Simulate the container entrypoint's restrictive umask (issue #617):
		// without a default, a freshly copied media file lands at 0600.
		originalUmask = process.umask(0o077);
	});

	afterEach(async () => {
		process.umask(originalUmask);
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('defaults a freshly transferred file to 0644 when no permission option is configured', async () => {
		const src = join(tmpDir, 'source.mkv');
		const dst = join(tmpDir, 'dest.mkv');
		await writeFile(src, 'content');
		await writeFile(dst, 'content');

		await applyFilePermissions(dst, src, false, '');

		const info = await stat(dst);
		expect(info.mode & 0o777).toBe(0o644);
	});

	it('still honors an explicit chmodFile override', async () => {
		const src = join(tmpDir, 'source.mkv');
		const dst = join(tmpDir, 'dest.mkv');
		await writeFile(src, 'content');
		await writeFile(dst, 'content');

		await applyFilePermissions(dst, src, false, '600');

		const info = await stat(dst);
		expect(info.mode & 0o777).toBe(0o600);
	});

	it('still honors preservePermissions (copies the source file mode)', async () => {
		const src = join(tmpDir, 'source.mkv');
		const dst = join(tmpDir, 'dest.mkv');
		await writeFile(src, 'content');
		await writeFile(dst, 'content');
		const { chmod } = await import('node:fs/promises');
		await chmod(src, 0o640);

		await applyFilePermissions(dst, src, true, '');

		const info = await stat(dst);
		expect(info.mode & 0o777).toBe(0o640);
	});
});

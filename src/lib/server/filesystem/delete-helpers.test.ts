import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	deleteDirectoryWithinRoot,
	deleteFilesWithinRoot,
	namesRootItself,
	resolvePathWithinRoot
} from './delete-helpers.js';

/**
 * Regression coverage for the root-equals-inside bug: `resolvePathWithinRoot`
 * treated a path equal to the root as contained, and MediaMatcher stores `.`
 * for a file sitting at the top of a library root. A single movie delete then
 * ran `rm -rf` on the entire library.
 */
describe('delete-helpers', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'cinephage-del-'));
		await mkdir(join(root, 'Test Movie (2024)'), { recursive: true });
		await writeFile(join(root, 'Test Movie (2024)', 'movie.mkv'), 'data');
		await writeFile(join(root, 'loose-movie.mkv'), 'data');
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	describe('resolvePathWithinRoot', () => {
		it('resolves a normal child path', () => {
			expect(resolvePathWithinRoot(root, 'Test Movie (2024)')).toBe(
				join(root, 'Test Movie (2024)')
			);
		});

		it.each(['.', './', '', '/'])('rejects %j, which names the root itself', (relativePath) => {
			expect(() => resolvePathWithinRoot(root, relativePath)).toThrow(/root folder itself/);
		});

		it('rejects traversal outside the root', () => {
			expect(() => resolvePathWithinRoot(root, '../escape')).toThrow(/outside root folder/);
			expect(() => resolvePathWithinRoot(root, 'a/../../escape')).toThrow(/outside root folder/);
		});

		it('treats an absolute-looking path as a child, not an escape', () => {
			// path.join does not reset on a leading slash, so '/etc' becomes
			// '<root>/etc'. This is safe (still inside the root); the assertion
			// pins the behaviour rather than the error message.
			expect(resolvePathWithinRoot(root, '/etc')).toBe(join(root, 'etc'));
		});
	});

	describe('namesRootItself', () => {
		it('is true for the root-level sentinel', () => {
			expect(namesRootItself(root, '.')).toBe(true);
			expect(namesRootItself(root, '')).toBe(true);
		});

		it('is false for a real child folder', () => {
			expect(namesRootItself(root, 'Test Movie (2024)')).toBe(false);
		});
	});

	describe('deleteDirectoryWithinRoot', () => {
		it('deletes a child directory and leaves the root intact', async () => {
			await deleteDirectoryWithinRoot(root, 'Test Movie (2024)');

			const remaining = await readdir(root);
			expect(remaining).toEqual(['loose-movie.mkv']);
		});

		it('refuses to delete the root itself', async () => {
			await expect(deleteDirectoryWithinRoot(root, '.')).rejects.toThrow(/root folder itself/);

			// The root and all of its contents must survive.
			const remaining = await readdir(root);
			expect(remaining.sort()).toEqual(['Test Movie (2024)', 'loose-movie.mkv']);
		});

		it('refuses to delete through a symlinked path component', async () => {
			const outside = await mkdtemp(join(tmpdir(), 'cinephage-outside-'));
			const victim = join(outside, 'victim');
			await mkdir(victim);
			await writeFile(join(victim, 'important.txt'), 'keep me');
			await symlink(outside, join(root, 'escape-link'));

			try {
				await expect(deleteDirectoryWithinRoot(root, 'escape-link/victim')).rejects.toThrow(
					/escapes root folder/
				);
				await expect(readdir(victim)).resolves.toEqual(['important.txt']);
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		});
	});

	describe('deleteFilesWithinRoot', () => {
		it('deletes only the named root-level files', async () => {
			await deleteFilesWithinRoot(root, ['loose-movie.mkv']);

			const remaining = await readdir(root);
			expect(remaining).toEqual(['Test Movie (2024)']);
		});

		it('rejects a traversal path', async () => {
			await expect(deleteFilesWithinRoot(root, ['../outside.mkv'])).rejects.toThrow(
				/outside root folder/
			);
		});
	});
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMediaDirectory } from './mkdir-helpers.js';

describe('ensureMediaDirectory', () => {
	let tmpDir: string;
	let originalUmask: number;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'cinephage-mkdir-helpers-'));
		// Simulate the container entrypoint's restrictive umask so this test
		// actually exercises the bug (issue #617): without the fix, a plain
		// `mkdir` under this umask lands at 0700, not the intended 0755.
		originalUmask = process.umask(0o077);
	});

	afterEach(async () => {
		process.umask(originalUmask);
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('creates a new directory with traversable (0755) permissions despite a restrictive umask', async () => {
		const target = join(tmpDir, 'Movies', 'Some Movie (2024)');

		await ensureMediaDirectory(target);

		const info = await stat(target);
		expect(info.mode & 0o777).toBe(0o755);
	});

	it('fixes permissions on every newly created ancestor, not just the leaf', async () => {
		const target = join(tmpDir, 'a', 'b', 'c');

		await ensureMediaDirectory(target);

		for (const segment of [join(tmpDir, 'a'), join(tmpDir, 'a', 'b'), target]) {
			const info = await stat(segment);
			expect(info.mode & 0o777).toBe(0o755);
		}
	});

	it('does not touch the permissions of an already-existing ancestor', async () => {
		const existing = join(tmpDir, 'existing');
		await mkdir(existing, { mode: 0o700 });
		// mkdir's explicit mode is also umask-masked; re-assert the exact mode
		// we want this test to start from, independent of mkdir's own masking.
		const { chmod } = await import('node:fs/promises');
		await chmod(existing, 0o700);

		const target = join(existing, 'new-subdir');
		await ensureMediaDirectory(target);

		const existingInfo = await stat(existing);
		const targetInfo = await stat(target);
		expect(existingInfo.mode & 0o777).toBe(0o700);
		expect(targetInfo.mode & 0o777).toBe(0o755);
	});

	it('is a no-op (does not throw or change permissions) when the directory already exists', async () => {
		const target = join(tmpDir, 'already-there');
		await mkdir(target, { mode: 0o700 });
		const { chmod } = await import('node:fs/promises');
		await chmod(target, 0o700);

		await ensureMediaDirectory(target);

		const info = await stat(target);
		expect(info.mode & 0o777).toBe(0o700);
	});
});

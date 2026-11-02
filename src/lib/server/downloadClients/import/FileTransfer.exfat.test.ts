/**
 * Regression tests for issue #490: imports fail with EPERM on filesystems
 * without per-file mode bits (exfat). Node's built-in copyFile preserves the
 * source mode via an implicit fchmod on the destination, which the exfat
 * kernel driver rejects outright. These tests simulate that by making
 * copyFile reject with EPERM (and link/rename reject with EXDEV so the copy
 * fallback path is exercised) and assert that transfers still succeed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: vi.fn(() => mockLogger)
}));

vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		link: vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
			),
		rename: vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
			),
		copyFile: vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error('EPERM: operation not permitted, copyfile'), { code: 'EPERM' })
			)
	};
});

import { transferFile, moveFile } from './FileTransfer';

describe('FileTransfer exfat compatibility (issue #490)', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'exfat-compat-'));
		mockLogger.warn.mockClear();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('copies a file when copyFile fails with EPERM (exfat fchmod rejection)', async () => {
		const source = join(dir, 'source.mkv');
		const dest = join(dir, 'nested', 'dest.mkv');
		await writeFile(source, Buffer.alloc(1024, 7));

		const result = await transferFile(source, dest, true);

		expect(result.success).toBe(true);
		expect(result.mode).toBe('copy');
		const data = await readFile(dest);
		expect(data.length).toBe(1024);
	});

	it('moves a file across filesystems when copyFile fails with EPERM (exfat fchmod rejection)', async () => {
		const source = join(dir, 'src.bin');
		const dest = join(dir, 'nested', 'dst.bin');
		await writeFile(source, 'hello world');

		const result = await moveFile(source, dest);

		expect(result.success).toBe(true);
		expect(result.mode).toBe('move');
		expect(await readFile(dest, 'utf8')).toBe('hello world');
	});
});

describe('FileTransfer hardlink->copy fallback visibility (issue #597)', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'hardlink-fallback-'));
		mockLogger.warn.mockClear();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('warns (not just debug-logs) when link() fails and falls back to copy', async () => {
		const source = join(dir, 'source.mkv');
		const dest = join(dir, 'nested', 'dest.mkv');
		await writeFile(source, Buffer.alloc(2048, 7));

		const result = await transferFile(source, dest, true);

		expect(result.success).toBe(true);
		expect(result.mode).toBe('copy');

		expect(mockLogger.warn).toHaveBeenCalledTimes(1);
		const [fields, message] = mockLogger.warn.mock.calls[0];
		expect(message).toContain('falling back to copy');
		expect(fields.code).toBe('EXDEV');
		expect(fields.sourceDir).toBe(dirname(source));
		expect(fields.destDir).toBe(dirname(dest));
		expect(fields.sizeBytes).toBe(2048);
	});
});

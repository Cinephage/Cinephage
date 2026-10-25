import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, symlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StreamingDiskScanner } from './StreamingDiskScanner.js';

async function createTempDir() {
	const root = await mkdtemp(join(tmpdir(), 'cinephage-test-scanner-'));
	return root;
}

async function cleanup(root: string) {
	await rm(root, { recursive: true, force: true });
}

const fakeVideo = Buffer.alloc(11 * 1024 * 1024, 'x');

describe('StreamingDiskScanner', () => {
	it('propagates the error when the root path itself cannot be opened', async () => {
		const scanner = new StreamingDiskScanner();
		const missingRoot = join(tmpdir(), 'cinephage-missing-root-scan-test');

		await expect(async () => {
			for await (const _batch of scanner.scan(missingRoot)) {
				// The generator must not yield anything for an inaccessible root.
			}
		}).rejects.toThrow();
	});

	it('discovers video files in a directory tree', async () => {
		const root = await createTempDir();
		await mkdir(join(root, 'Movies', 'Some Movie (2020)'), { recursive: true });
		await writeFile(join(root, 'Movies', 'Some Movie (2020)', 'Movie.mkv'), fakeVideo);
		await writeFile(join(root, 'Movies', 'Trailer.mp4'), fakeVideo);
		await writeFile(join(root, 'random.txt'), 'text');
		await mkdir(join(root, '.hidden'), { recursive: true });
		await writeFile(join(root, '.hidden', 'secret.mkv'), fakeVideo);

		const scanner = new StreamingDiskScanner({ batchSize: 2 });
		const batches: Array<Array<{ relativePath: string }>> = [];
		for await (const batch of scanner.scan(root)) {
			batches.push(batch);
		}

		const allFiles = batches.flat();
		expect(allFiles).toHaveLength(2);

		const paths = allFiles.map((f) => f.relativePath).sort();
		expect(paths).toEqual(['Movies/Some Movie (2020)/Movie.mkv', 'Movies/Trailer.mp4']);

		await cleanup(root);
	});

	it('traverses an excluded dot-prefixed folder when it contains a tracked movie path', async () => {
		const root = await createTempDir();
		const movieFolder = join(root, '...And Justice for All (1979)');
		const moviePath = join(movieFolder, '...And Justice for All (1979).mkv');
		await mkdir(movieFolder, { recursive: true });
		await writeFile(moviePath, fakeVideo);
		await writeFile(join(movieFolder, 'sample.mkv'), fakeVideo);

		await mkdir(join(root, '.hidden'), { recursive: true });
		await writeFile(join(root, '.hidden', 'secret.mkv'), fakeVideo);

		const scanner = new StreamingDiskScanner({ alwaysScanPaths: [moviePath] });
		const allFiles: Array<{ relativePath: string }> = [];
		for await (const batch of scanner.scan(root)) {
			allFiles.push(...batch);
		}

		expect(allFiles.map((file) => file.relativePath)).toEqual([
			join('...And Justice for All (1979)', '...And Justice for All (1979).mkv')
		]);

		await cleanup(root);
	});

	it('excludes samples and extras folders', async () => {
		const root = await createTempDir();
		await mkdir(join(root, 'Season 1'), { recursive: true });
		await writeFile(join(root, 'Season 1', 'Episode 01.mkv'), fakeVideo);
		await mkdir(join(root, 'Sample'), { recursive: true });
		await writeFile(join(root, 'Sample', 'sample.mkv'), fakeVideo);
		await mkdir(join(root, 'Extras'), { recursive: true });
		await writeFile(join(root, 'Extras', 'behind.mkv'), fakeVideo);

		const scanner = new StreamingDiskScanner();
		const allFiles: Array<{ relativePath: string }> = [];
		for await (const batch of scanner.scan(root)) {
			allFiles.push(...batch);
		}

		expect(allFiles).toHaveLength(1);
		expect(allFiles[0].relativePath).toBe('Season 1/Episode 01.mkv');

		await cleanup(root);
	});

	it('respects custom blocked extensions', async () => {
		const root = await createTempDir();
		await writeFile(join(root, 'show.mkv'), fakeVideo);
		await writeFile(join(root, 'bad.webm'), fakeVideo);

		const scanner = new StreamingDiskScanner({ blockedExtensions: ['.webm'] });
		const allFiles: Array<{ relativePath: string }> = [];
		for await (const batch of scanner.scan(root)) {
			allFiles.push(...batch);
		}

		expect(allFiles).toHaveLength(1);
		expect(allFiles[0].relativePath).toBe('show.mkv');

		await cleanup(root);
	});

	it('handles symlinked files', async () => {
		const root = await createTempDir();
		const target = join(root, 'real.mkv');
		await writeFile(target, fakeVideo);
		const link = join(root, 'link.mkv');
		await symlink(target, link);

		const scanner = new StreamingDiskScanner();
		const allFiles: Array<{ relativePath: string }> = [];
		for await (const batch of scanner.scan(root)) {
			allFiles.push(...batch);
		}

		expect(allFiles).toHaveLength(2);

		await cleanup(root);
	});

	it('yields batches respecting batch size', async () => {
		const root = await createTempDir();
		for (let i = 0; i < 5; i++) {
			await writeFile(join(root, `video-${i}.mkv`), fakeVideo);
		}

		const scanner = new StreamingDiskScanner({ batchSize: 2 });
		const batches: Array<Array<{ relativePath: string }>> = [];
		for await (const batch of scanner.scan(root)) {
			batches.push(batch);
		}

		expect(batches).toHaveLength(3);
		expect(batches[0]).toHaveLength(2);
		expect(batches[1]).toHaveLength(2);
		expect(batches[2]).toHaveLength(1);

		await cleanup(root);
	});
});

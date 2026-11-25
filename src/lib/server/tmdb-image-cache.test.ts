import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTmdbImage, isValidTmdbImageRequest, tmdbImageContentType } from './tmdb-image-cache';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function okFetch() {
	return vi.fn(async () => new Response(PNG, { status: 200 })) as unknown as typeof fetch & {
		mock: { calls: unknown[][] };
	};
}

describe('isValidTmdbImageRequest', () => {
	it('accepts TMDB sizes and bare file names', () => {
		expect(isValidTmdbImageRequest('w342', 'abcDEF123_-x.jpg')).toBe(true);
		expect(isValidTmdbImageRequest('original', 'logo.svg')).toBe(true);
	});

	it('rejects unknown sizes, traversal and other types', () => {
		expect(isValidTmdbImageRequest('w9999', 'a.jpg')).toBe(false);
		expect(isValidTmdbImageRequest('w342', '../a.jpg')).toBe(false);
		expect(isValidTmdbImageRequest('w342', 'a/b.jpg')).toBe(false);
		expect(isValidTmdbImageRequest('w342', 'a.html')).toBe(false);
		expect(isValidTmdbImageRequest('w342', '.jpg')).toBe(false);
	});

	it('maps extensions to content types', () => {
		expect(tmdbImageContentType('a.jpg')).toBe('image/jpeg');
		expect(tmdbImageContentType('a.svg')).toBe('image/svg+xml');
	});
});

describe('getTmdbImage', () => {
	let dataDir: string;
	const previous = process.env.DATA_DIR;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'tmdb-image-cache-'));
		process.env.DATA_DIR = dataDir;
	});

	afterEach(async () => {
		if (previous === undefined) delete process.env.DATA_DIR;
		else process.env.DATA_DIR = previous;
		await rm(dataDir, { recursive: true, force: true });
	});

	it('fetches a miss from TMDB once, stores it, then serves it from disk', async () => {
		const fetchImpl = okFetch();
		const first = await getTmdbImage('w342', 'poster.png', fetchImpl);
		expect(first?.body).toEqual(PNG);
		expect(first?.contentType).toBe('image/png');
		expect(fetchImpl.mock.calls[0][0]).toBe('https://image.tmdb.org/t/p/w342/poster.png');

		const stored = await readFile(join(dataDir, 'cache', 'tmdb-images', 'w342', 'poster.png'));
		expect(new Uint8Array(stored)).toEqual(PNG);

		const second = await getTmdbImage('w342', 'poster.png', fetchImpl);
		expect(second?.body).toEqual(PNG);
		expect(fetchImpl.mock.calls).toHaveLength(1);
	});

	it('shares one TMDB fetch between concurrent requests', async () => {
		const fetchImpl = okFetch();
		const results = await Promise.all([
			getTmdbImage('w185', 'same.png', fetchImpl),
			getTmdbImage('w185', 'same.png', fetchImpl),
			getTmdbImage('w185', 'same.png', fetchImpl)
		]);
		expect(results.every((r) => r?.body.byteLength === PNG.byteLength)).toBe(true);
		expect(fetchImpl.mock.calls).toHaveLength(1);
	});

	it('returns null and caches nothing when TMDB answers with an error', async () => {
		const fetchImpl = vi.fn(
			async () => new Response('nope', { status: 404 })
		) as unknown as typeof fetch;
		expect(await getTmdbImage('w342', 'missing.jpg', fetchImpl)).toBeNull();
		await expect(
			readFile(join(dataDir, 'cache', 'tmdb-images', 'w342', 'missing.jpg'))
		).rejects.toThrow();
	});

	it('returns null when TMDB cannot be reached', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		expect(await getTmdbImage('w342', 'offline.jpg', fetchImpl)).toBeNull();
	});
});
